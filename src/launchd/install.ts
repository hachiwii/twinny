import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { createRuntimePaths, readConfigStatus, resolveTwinnyHome } from "../config/index.js";
import { isTwinnyLockHeld, readTwinnyLockPid } from "../lock/index.js";
import { createLaunchAgentPlist, launchAgentLabel } from "./plist.js";

const defaultStopWaitTimeoutMs = 35_000;
const defaultStopWaitPollMs = 250;
const runtimeLockStaleMs = 30_000;

export interface WaitForRuntimeLockReleaseOptions {
  home?: string;
  timeoutMs?: number;
  pollMs?: number;
}

export async function installLaunchAgent(): Promise<void> {
  const status = await ensureConfiguredBeforeInstall();
  if (!status.complete) {
    throw new Error(`Twinny home is not configured. Issues: ${status.issues.join("; ")}`);
  }
  const plistPath = getLaunchAgentPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, createLaunchAgentPlist(), "utf8");
  console.log(`Installed ${launchAgentLabel} at ${plistPath}`);
}

export async function uninstallLaunchAgent(): Promise<void> {
  const plistPath = getLaunchAgentPath();
  await execa("launchctl", ["bootout", `gui/${process.getuid?.() ?? os.userInfo().uid}`, plistPath], {
    reject: false
  });
  if (fs.existsSync(plistPath)) {
    fs.rmSync(plistPath);
  }
  console.log(`Uninstalled ${launchAgentLabel}`);
}

export async function startLaunchAgent(): Promise<void> {
  const plistPath = getLaunchAgentPath();
  if (!fs.existsSync(plistPath)) {
    await installLaunchAgent();
    return;
  }
  await execa("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? os.userInfo().uid}`, plistPath], {
    reject: false
  });
  await execa("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? os.userInfo().uid}/${launchAgentLabel}`]);
  console.log(`Started ${launchAgentLabel}`);
}

export async function stopLaunchAgent(): Promise<void> {
  await execa("launchctl", ["bootout", `gui/${process.getuid?.() ?? os.userInfo().uid}`, getLaunchAgentPath()], {
    reject: false
  });
  await waitForRuntimeLockRelease();
  console.log(`Stopped ${launchAgentLabel}`);
}

export async function restartLaunchAgent(): Promise<void> {
  await stopLaunchAgent();
  await startLaunchAgent();
}

export async function waitForRuntimeLockRelease(options: WaitForRuntimeLockReleaseOptions = {}): Promise<void> {
  const paths = createRuntimePaths(options.home ?? resolveTwinnyHome());
  const timeoutMs = options.timeoutMs ?? defaultStopWaitTimeoutMs;
  const pollMs = options.pollMs ?? defaultStopWaitPollMs;
  const deadline = Date.now() + timeoutMs;

  while (await isTwinnyLockHeld(paths, { stale: runtimeLockStaleMs })) {
    if (Date.now() >= deadline) {
      const pid = await readTwinnyLockPid(paths, { stale: runtimeLockStaleMs });
      const detail = pid ? `pid ${pid}` : "unknown pid";
      throw new Error(`Timed out waiting for Twinny runtime lock to release (${detail})`);
    }
    await sleep(pollMs);
  }
}

export async function statusLaunchAgent(): Promise<void> {
  const result = await execa("launchctl", ["print", `gui/${process.getuid?.() ?? os.userInfo().uid}/${launchAgentLabel}`], {
    reject: false
  });
  if (result.exitCode === 0) {
    console.log(result.stdout);
    return;
  }
  console.log(`${launchAgentLabel} is not loaded`);
}

export async function tailLogs(): Promise<void> {
  const logPath = path.join(os.homedir(), "Library", "Logs", "twinny", "daemon.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "", "utf8");
  }
  await execa("tail", ["-f", logPath], { stdio: "inherit" });
}

function getLaunchAgentPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${launchAgentLabel}.plist`);
}

async function ensureConfiguredBeforeInstall(): Promise<Awaited<ReturnType<typeof readConfigStatus>>> {
  return readConfigStatus();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
