import { execa } from "execa";

type CommandRunner = typeof execa;

export interface ResolveExecutableOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
}

export interface ShellCommand {
  command: string;
  args: string[];
}

export async function resolveExecutable(
  name: string,
  options: ResolveExecutableOptions = {}
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? execa;
  const command = platform === "win32" ? "where" : "which";
  const result = await runCommand(command, [name], { reject: false, env: options.env });
  if (result.exitCode !== 0) {
    return undefined;
  }
  return firstOutputLine(result.stdout);
}

export function npmBinNameForPlatform(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${name}.cmd` : name;
}

export function commandForPlatform(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): ShellCommand {
  if (platform !== "win32" || !isWindowsCommandShim(command)) {
    return { command, args };
  }
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", [quoteCmdArgument(command), ...args.map(quoteCmdArgument)].join(" ")]
  };
}

export function pathExtsForPlatform(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform !== "win32") {
    return [""];
  }
  return (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function firstOutputLine(stdout: unknown): string | undefined {
  const line = String(stdout ?? "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line || undefined;
}

function isWindowsCommandShim(command: string): boolean {
  return /\.(?:cmd|bat)$/i.test(command);
}

function quoteCmdArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
