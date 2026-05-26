import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { createRuntimePaths, readConfigStatus } from "../config/index.js";
import { waitForRuntimeLockRelease, type WaitForRuntimeLockReleaseOptions } from "../service/lock.js";
import type { TwinnyConfig } from "../types.js";
import { createLaunchAgentPlist, launchAgentLabelForHomeRandom, launchAgentPlistPathForLabel } from "./plist.js";

export { waitForRuntimeLockRelease, type WaitForRuntimeLockReleaseOptions };

export interface LaunchAgentCommandOptions {
  home?: string;
  quiet?: boolean;
}

export interface InstallLaunchAgentOptions extends LaunchAgentCommandOptions {
  config?: TwinnyConfig;
  entrypoint?: string;
  environment?: Record<string, string | undefined>;
}

interface LaunchAgentRuntime {
  home: string;
  label: string;
  plistPath: string;
  config: TwinnyConfig;
}

export async function installLaunchAgent(options: InstallLaunchAgentOptions = {}): Promise<void> {
  const runtime = await resolveLaunchAgentRuntime(options);
  const plistPath = runtime.plistPath;
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(
    plistPath,
    createLaunchAgentPlist({
      label: runtime.label,
      twinnyHome: runtime.home,
      entrypoint: options.entrypoint,
      environment: options.environment
    }),
    "utf8"
  );
  if (!options.quiet) {
    console.log(`Installed ${runtime.label} at ${plistPath}`);
  }
}

export async function uninstallLaunchAgent(options: LaunchAgentCommandOptions = {}): Promise<void> {
  const runtime = await resolveLaunchAgentRuntime(options);
  const plistPath = runtime.plistPath;
  await execa("launchctl", ["bootout", `gui/${process.getuid?.() ?? os.userInfo().uid}`, plistPath], {
    reject: false
  });
  if (fs.existsSync(plistPath)) {
    fs.rmSync(plistPath);
  }
  if (!options.quiet) {
    console.log(`Uninstalled ${runtime.label}`);
  }
}

export async function startLaunchAgent(options: LaunchAgentCommandOptions = {}): Promise<void> {
  const runtime = await resolveLaunchAgentRuntime(options);
  const plistPath = runtime.plistPath;
  if (!fs.existsSync(plistPath)) {
    await installLaunchAgent(options);
    return;
  }
  await execa("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? os.userInfo().uid}`, plistPath], {
    reject: false
  });
  await execa("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? os.userInfo().uid}/${runtime.label}`]);
  if (!options.quiet) {
    console.log(`Started ${runtime.label}`);
  }
}

export async function stopLaunchAgent(options: LaunchAgentCommandOptions = {}): Promise<void> {
  const runtime = await resolveLaunchAgentRuntime(options);
  await execa("launchctl", ["bootout", `gui/${process.getuid?.() ?? os.userInfo().uid}`, runtime.plistPath], {
    reject: false
  });
  await waitForRuntimeLockRelease({ home: runtime.home });
  if (!options.quiet) {
    console.log(`Stopped ${runtime.label}`);
  }
}

export async function restartLaunchAgent(options: LaunchAgentCommandOptions = {}): Promise<void> {
  await stopLaunchAgent(options);
  await startLaunchAgent(options);
}

export async function statusLaunchAgent(options: LaunchAgentCommandOptions = {}): Promise<void> {
  const runtime = await resolveLaunchAgentRuntime(options);
  const result = await execa("launchctl", ["print", `gui/${process.getuid?.() ?? os.userInfo().uid}/${runtime.label}`], {
    reject: false
  });
  if (result.exitCode === 0) {
    console.log(result.stdout);
    return;
  }
  console.log(`${runtime.label} is not loaded`);
}

export async function tailLogs(options: LaunchAgentCommandOptions = {}): Promise<void> {
  const runtime = await resolveLaunchAgentRuntime(options);
  const logPath = path.join(os.homedir(), "Library", "Logs", "twinny", `${runtime.label}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "", "utf8");
  }
  await execa("tail", ["-f", logPath], { stdio: "inherit" });
}

function getLaunchAgentPath(label: string): string {
  return launchAgentPlistPathForLabel(label);
}

async function resolveLaunchAgentRuntime(options: InstallLaunchAgentOptions = {}): Promise<LaunchAgentRuntime> {
  const status = options.config
    ? { complete: true, issues: [], config: options.config, paths: createRuntimePaths(options.config.home) }
    : await readConfigStatus({ home: options.home });
  if (!status.complete || !status.config) {
    throw new Error(`Twinny home is not configured. Issues: ${status.issues.join("; ")}`);
  }
  const label = launchAgentLabelForHomeRandom(status.config.homeIdentity.random);
  return {
    home: status.paths.home,
    label,
    plistPath: getLaunchAgentPath(label),
    config: status.config
  };
}
