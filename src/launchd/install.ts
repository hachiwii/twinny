import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { createRuntimePaths, readConfigStatus } from "../config/index.js";
import { waitForRuntimeLockRelease, type WaitForRuntimeLockReleaseOptions } from "../service/lock.js";
import type { LaunchdServiceMode, TwinnyConfig } from "../types.js";
import {
  createLaunchAgentPlist,
  launchAgentLabelForHomeRandom,
  launchAgentPlistPathForLabel,
  launchDaemonPlistPathForLabel
} from "./plist.js";

export { waitForRuntimeLockRelease, type WaitForRuntimeLockReleaseOptions };

type CommandRunner = typeof execa;

export interface LaunchAgentCommandOptions {
  home?: string;
  config?: TwinnyConfig;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
  runCommand?: CommandRunner;
  launchAgentDir?: string;
  launchDaemonDir?: string;
}

export interface InstallLaunchAgentOptions extends LaunchAgentCommandOptions {
  config?: TwinnyConfig;
  entrypoint?: string;
  environment?: Record<string, string | undefined>;
}

interface LaunchAgentRuntime {
  home: string;
  label: string;
  mode: LaunchdServiceMode;
  plistPath: string;
  launchctlDomain: string;
  launchctlTarget: string;
  userName?: string;
  config: TwinnyConfig;
  runCommand: CommandRunner;
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
      userName: runtime.userName,
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
  await runtime.runCommand("launchctl", ["bootout", runtime.launchctlDomain, plistPath], {
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
  }
  await runtime.runCommand("launchctl", ["bootstrap", runtime.launchctlDomain, plistPath], {
    reject: false
  });
  await runtime.runCommand("launchctl", ["kickstart", "-k", runtime.launchctlTarget]);
  if (!options.quiet) {
    console.log(`Started ${runtime.label}`);
  }
}

export async function stopLaunchAgent(options: LaunchAgentCommandOptions = {}): Promise<void> {
  const runtime = await resolveLaunchAgentRuntime(options);
  await runtime.runCommand("launchctl", ["bootout", runtime.launchctlDomain, runtime.plistPath], {
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
  const result = await runtime.runCommand("launchctl", ["print", runtime.launchctlTarget], {
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
  await runtime.runCommand("tail", ["-f", logPath], { stdio: "inherit" });
}

export async function assertLaunchdGuiSessionAvailable(options: {
  uid?: number;
  runCommand?: CommandRunner;
} = {}): Promise<void> {
  const uid = options.uid ?? process.getuid?.() ?? os.userInfo().uid;
  const domain = `gui/${uid}`;
  const result = await (options.runCommand ?? execa)("launchctl", ["print", domain], { reject: false });
  if (result.exitCode === 0) {
    return;
  }
  const details = [result.stderr, result.stdout].filter((value) => value.trim()).join("\n");
  throw new Error(
    `当前环境没有可用的 GUI LaunchAgent (${domain})。请使用 \`twinny install --no-gui\` 安装为 LaunchDaemon。${details ? `\n${details}` : ""}`
  );
}

function getLaunchdPlistPath(label: string, mode: LaunchdServiceMode, options: LaunchAgentCommandOptions): string {
  if (mode === "daemon") {
    return options.launchDaemonDir
      ? path.join(options.launchDaemonDir, `${label}.plist`)
      : launchDaemonPlistPathForLabel(label);
  }
  if (options.launchAgentDir) {
    return path.join(options.launchAgentDir, `${label}.plist`);
  }
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
  const mode = status.config.service.launchd.mode;
  const launchctlDomain = mode === "daemon" ? "system" : `gui/${process.getuid?.() ?? os.userInfo().uid}`;
  const userName = mode === "daemon" ? status.config.service.launchd.userName : undefined;
  return {
    home: status.paths.home,
    label,
    mode,
    plistPath: getLaunchdPlistPath(label, mode, options),
    launchctlDomain,
    launchctlTarget: `${launchctlDomain}/${label}`,
    ...(userName ? { userName } : {}),
    config: status.config,
    runCommand: options.runCommand ?? execa
  };
}
