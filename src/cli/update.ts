import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { readConfigStatus } from "../config/index.js";
import { restartLaunchAgent } from "../launchd/install.js";
import {
  launchAgentLabelForHomeRandom,
  launchAgentPlistPathForLabel,
  launchDaemonPlistPathForLabel,
  launchAgentUsesEntrypoint
} from "../launchd/plist.js";
import { twinnyRunnerBinaryPath, twinnyRunnerDir } from "../platform/runner.js";
import { resolveManagedServiceKind, restartManagedService, type ManagedServiceKind } from "../service/index.js";
import { systemdUserServicePathForHomeRandom } from "../systemd/install.js";
import type { LaunchdServiceMode } from "../types.js";
import { windowsTaskUsesEntrypoint } from "../windows/task.js";

export { twinnyRunnerBinaryPath, twinnyRunnerDir } from "../platform/runner.js";

type CommandRunner = typeof execa;
type UpdateOutput = Pick<NodeJS.WriteStream, "write">;
type RestartLaunchAgentFn = typeof restartLaunchAgent;
type RestartManagedServiceFn = typeof restartManagedService;

export interface RunUpdateCommandOptions {
  home?: string;
  restart?: boolean;
  packageSpec?: string;
  runCommand?: CommandRunner;
  restartLaunchAgent?: RestartLaunchAgentFn;
  restartManagedService?: RestartManagedServiceFn;
  stdout?: UpdateOutput;
  platform?: NodeJS.Platform;
  launchAgentPlistPath?: string;
  serviceFilePath?: string;
}

export interface UpdateRunnerResult {
  home: string;
  runnerDir: string;
  runnerBinary: string;
  packageSpec: string;
  managedServiceUsesRunner: boolean;
  launchAgentUsesRunner: boolean;
  restarted: boolean;
}

export async function runUpdateCommand(options: RunUpdateCommandOptions = {}): Promise<UpdateRunnerResult> {
  const output = options.stdout ?? process.stdout;
  const status = await readConfigStatus({ home: options.home });
  if (!status.exists || !status.complete || !status.config) {
    throw new Error(`Twinny home is not configured. Issues: ${status.issues.join("; ")}`);
  }

  const home = status.paths.home;
  const runnerDir = twinnyRunnerDir(home);
  const platform = options.platform ?? process.platform;
  const runnerBinary = twinnyRunnerBinaryPath(home, platform);
  const packageSpec = options.packageSpec ?? await defaultUpdatePackageSpec();
  await installRunnerPackage(runnerDir, packageSpec, options.runCommand ?? execa);
  output.write(`Updated Twinny runner: ${runnerBinary}\n`);

  const serviceKind = await resolveManagedServiceKind({ platform });
  const managedServiceUsesRunner = await currentManagedServiceUsesRunner({
    kind: serviceKind,
    home,
    homeRandom: status.config.homeIdentity.random,
    launchdMode: status.config.service.launchd.mode,
    runnerBinary,
    serviceFilePath: options.serviceFilePath ?? options.launchAgentPlistPath
  });
  const launchAgentUsesRunner = managedServiceUsesRunner;
  const shouldRestart = options.restart ?? true;
  if (!shouldRestart) {
    output.write("Skipped restart. Run `twinny restart` when you are ready to use the updated runner.\n");
    return { home, runnerDir, runnerBinary, packageSpec, managedServiceUsesRunner, launchAgentUsesRunner, restarted: false };
  }
  if (!managedServiceUsesRunner) {
    output.write(`Skipped restart because the current ${managedServiceLabel(serviceKind)} does not use the Twinny runner.\n`);
    output.write("Re-run `twinny install` with npx if you want managed service updates to use this runner.\n");
    return { home, runnerDir, runnerBinary, packageSpec, managedServiceUsesRunner, launchAgentUsesRunner, restarted: false };
  }

  output.write("Restarting Twinny...\n");
  try {
    if (options.restartLaunchAgent) {
      await options.restartLaunchAgent({ home });
    } else {
      await (options.restartManagedService ?? restartManagedService)({ home, platform });
    }
  } catch (error) {
    throw new Error(`Twinny runner was updated, but restart failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
  output.write("Twinny restarted.\n");
  return { home, runnerDir, runnerBinary, packageSpec, managedServiceUsesRunner, launchAgentUsesRunner, restarted: true };
}

async function installRunnerPackage(runnerDir: string, packageSpec: string, runCommand: CommandRunner): Promise<void> {
  try {
    await runCommand("npm", ["install", "--prefix", runnerDir, "--omit=dev", "--no-audit", "--no-fund", packageSpec], {
      stdio: "pipe"
    });
  } catch (error) {
    const output = childProcessErrorOutput(error);
    throw new Error(output ? `failed to update Twinny runner:\n${output}` : "failed to update Twinny runner", {
      cause: error
    });
  }
}

async function currentLaunchAgentUsesRunner(input: {
  homeRandom: string;
  launchdMode: LaunchdServiceMode;
  runnerBinary: string;
  launchAgentPlistPath?: string;
}): Promise<boolean> {
  const label = launchAgentLabelForHomeRandom(input.homeRandom);
  const plistPath = input.launchAgentPlistPath
    ?? (input.launchdMode === "daemon" ? launchDaemonPlistPathForLabel(label) : launchAgentPlistPathForLabel(label));
  let plist: string;
  try {
    plist = await fs.readFile(plistPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  return launchAgentUsesEntrypoint(plist, input.runnerBinary);
}

async function currentManagedServiceUsesRunner(input: {
  kind: ManagedServiceKind;
  home: string;
  homeRandom: string;
  launchdMode: LaunchdServiceMode;
  runnerBinary: string;
  serviceFilePath?: string;
}): Promise<boolean> {
  if (input.kind === "launchd") {
    return currentLaunchAgentUsesRunner({
      homeRandom: input.homeRandom,
      launchdMode: input.launchdMode,
      runnerBinary: input.runnerBinary,
      launchAgentPlistPath: input.serviceFilePath
    });
  }
  if (input.kind === "systemd") {
    return textFileIncludes(input.serviceFilePath ?? systemdUserServicePathForHomeRandom(input.homeRandom), input.runnerBinary);
  }
  if (input.kind === "windows-task") {
    return windowsTaskUsesEntrypoint({
      home: input.home,
      entrypoint: input.runnerBinary,
      launcherPath: input.serviceFilePath
    });
  }
  return false;
}

async function textFileIncludes(filePath: string, expected: string): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  return content.includes(path.resolve(expected));
}

function managedServiceLabel(kind: ManagedServiceKind): string {
  switch (kind) {
    case "launchd":
      return "LaunchAgent";
    case "systemd":
      return "systemd user service";
    case "windows-task":
      return "Windows scheduled task";
    case "manual":
      return "foreground runner";
  }
}

async function defaultUpdatePackageSpec(): Promise<string> {
  const identity = await readPackageIdentity();
  return `${identity.name}@${identity.version}`;
}

async function readPackageIdentity(): Promise<{ name: string; version: string }> {
  const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const raw = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    throw new Error("package.json is missing name");
  }
  if (typeof raw.version !== "string" || !raw.version.trim()) {
    throw new Error("package.json is missing version");
  }
  return { name: raw.name.trim(), version: raw.version.trim() };
}

function childProcessErrorOutput(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const record = error as { shortMessage?: unknown; stderr?: unknown; stdout?: unknown };
  return [record.shortMessage, record.stderr, record.stdout]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .filter((value, index, values) => values.indexOf(value) === index)
    .join("\n");
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
