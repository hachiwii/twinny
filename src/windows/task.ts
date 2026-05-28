import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { createRuntimePaths, readConfigStatus } from "../config/index.js";
import { waitForRuntimeLockRelease } from "../service/lock.js";
import type { TwinnyConfig } from "../types.js";

type CommandRunner = typeof execa;

export interface WindowsTaskCommandOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
}

export interface InstallWindowsTaskOptions extends WindowsTaskCommandOptions {
  config?: TwinnyConfig;
  entrypoint?: string;
  environment?: Record<string, string | undefined>;
}

interface WindowsTaskRuntime {
  home: string;
  taskName: string;
  launcherPath: string;
  logPath: string;
  config: TwinnyConfig;
  runCommand: CommandRunner;
}

export function windowsTaskNameForHomeRandom(homeRandom: string): string {
  const homeId = createHash("sha256").update(homeRandom.trim().toLowerCase()).digest("hex").slice(0, 16);
  return `\\Twinny\\twinny-${homeId}`;
}

export function windowsTaskLauncherPath(home: string): string {
  return path.join(home, "runtime", "twinny-task.cmd");
}

export function windowsTaskLogPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.LOCALAPPDATA?.trim() || path.join(home, "runtime"), "Twinny", "logs", "twinny-task.log");
}

export function createWindowsTaskLauncher(options: {
  twinnyHome: string;
  entrypoint?: string;
  environment?: Record<string, string | undefined>;
  logPath?: string;
}): string {
  const entrypoint = normalizeWindowsPath(options.entrypoint ?? process.argv[1] ?? process.execPath);
  const logPath = options.logPath ?? windowsTaskLogPath(options.twinnyHome);
  const environment = normalizeEnvironment({
    ...(options.environment ?? {}),
    TWINNY_HOME: options.twinnyHome
  });
  const command = windowsEntrypointCommand(entrypoint);
  return [
    "@echo off",
    "setlocal",
    ...Object.entries(environment).map(([key, value]) => `set "${key}=${escapeCmdSetValue(value)}"`),
    `if not exist "${escapeCmdPath(path.dirname(logPath))}" mkdir "${escapeCmdPath(path.dirname(logPath))}"`,
    `cd /d "${escapeCmdPath(options.twinnyHome)}"`,
    `${command} >> "${escapeCmdPath(logPath)}" 2>&1`,
    "exit /b %ERRORLEVEL%",
    ""
  ].join("\r\n");
}

export async function installWindowsTask(options: InstallWindowsTaskOptions = {}): Promise<void> {
  const runtime = await resolveWindowsTaskRuntime(options);
  fs.mkdirSync(path.dirname(runtime.launcherPath), { recursive: true });
  fs.mkdirSync(path.dirname(runtime.logPath), { recursive: true });
  fs.writeFileSync(runtime.launcherPath, createWindowsTaskLauncher({
    twinnyHome: runtime.home,
    entrypoint: options.entrypoint,
    environment: options.environment,
    logPath: runtime.logPath
  }), "utf8");
  await runtime.runCommand("schtasks", [
    "/Create",
    "/TN",
    runtime.taskName,
    "/TR",
    quoteWindowsTaskRun(runtime.launcherPath),
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/F"
  ]);
  console.log(`Installed ${runtime.taskName} at ${runtime.launcherPath}`);
}

export async function uninstallWindowsTask(options: WindowsTaskCommandOptions = {}): Promise<void> {
  const runtime = await resolveWindowsTaskRuntime(options);
  await runtime.runCommand("schtasks", ["/Delete", "/TN", runtime.taskName, "/F"], { reject: false });
  if (fs.existsSync(runtime.launcherPath)) {
    fs.rmSync(runtime.launcherPath);
  }
  console.log(`Uninstalled ${runtime.taskName}`);
}

export async function startWindowsTask(options: WindowsTaskCommandOptions = {}): Promise<void> {
  const runtime = await resolveWindowsTaskRuntime(options);
  await runtime.runCommand("schtasks", ["/Run", "/TN", runtime.taskName]);
  console.log(`Started ${runtime.taskName}`);
}

export async function stopWindowsTask(options: WindowsTaskCommandOptions = {}): Promise<void> {
  const runtime = await resolveWindowsTaskRuntime(options);
  await runtime.runCommand("schtasks", ["/End", "/TN", runtime.taskName], { reject: false });
  await waitForRuntimeLockRelease({ home: runtime.home });
  console.log(`Stopped ${runtime.taskName}`);
}

export async function restartWindowsTask(options: WindowsTaskCommandOptions = {}): Promise<void> {
  await stopWindowsTask(options);
  await startWindowsTask(options);
}

export async function statusWindowsTask(options: WindowsTaskCommandOptions = {}): Promise<void> {
  const runtime = await resolveWindowsTaskRuntime(options);
  const result = await runtime.runCommand("schtasks", ["/Query", "/TN", runtime.taskName, "/V", "/FO", "LIST"], {
    reject: false
  });
  console.log(result.stdout || result.stderr || `${runtime.taskName} is not registered`);
}

export async function tailWindowsTaskLogs(options: WindowsTaskCommandOptions = {}): Promise<void> {
  const runtime = await resolveWindowsTaskRuntime(options);
  if (!fs.existsSync(runtime.logPath)) {
    fs.mkdirSync(path.dirname(runtime.logPath), { recursive: true });
    fs.writeFileSync(runtime.logPath, "", "utf8");
  }
  await runtime.runCommand("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Get-Content -LiteralPath ${quotePowerShellString(runtime.logPath)} -Tail 80 -Wait`
  ], { stdio: "inherit" });
}

export async function windowsTaskUsesEntrypoint(input: {
  home: string;
  entrypoint: string;
  launcherPath?: string;
}): Promise<boolean> {
  const launcherPath = input.launcherPath ?? windowsTaskLauncherPath(input.home);
  let launcher: string;
  try {
    launcher = await fs.promises.readFile(launcherPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  return launcher.includes(normalizeWindowsPath(input.entrypoint));
}

async function resolveWindowsTaskRuntime(options: InstallWindowsTaskOptions = {}): Promise<WindowsTaskRuntime> {
  const status = options.config
    ? { complete: true, issues: [], config: options.config, paths: createRuntimePaths(options.config.home) }
    : await readConfigStatus({ home: options.home });
  if (!status.complete || !status.config) {
    throw new Error(`Twinny home is not configured. Issues: ${status.issues.join("; ")}`);
  }
  return {
    home: status.paths.home,
    taskName: windowsTaskNameForHomeRandom(status.config.homeIdentity.random),
    launcherPath: windowsTaskLauncherPath(status.paths.home),
    logPath: windowsTaskLogPath(status.paths.home, options.env),
    config: status.config,
    runCommand: options.runCommand ?? execa
  };
}

function windowsEntrypointCommand(entrypoint: string): string {
  if (entrypoint === process.execPath) {
    return `${quoteCmdPath(process.execPath)} run`;
  }
  if (/\.(?:cmd|bat)$/i.test(entrypoint)) {
    return `call ${quoteCmdPath(entrypoint)} run`;
  }
  if (/\.(?:exe|com)$/i.test(entrypoint)) {
    return `${quoteCmdPath(entrypoint)} run`;
  }
  return `${quoteCmdPath(process.execPath)} ${quoteCmdPath(entrypoint)} run`;
}

function normalizeWindowsPath(value: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) {
    return value;
  }
  return path.resolve(value);
}

function normalizeEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment)
      .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)])
  );
}

function quoteWindowsTaskRun(value: string): string {
  return `"${value}"`;
}

function quoteCmdPath(value: string): string {
  return `"${escapeCmdPath(value)}"`;
}

function escapeCmdPath(value: string): string {
  return value.replaceAll('"', '\\"');
}

function escapeCmdSetValue(value: string): string {
  return value.replaceAll('"', '\\"');
}

function quotePowerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
