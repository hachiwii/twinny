import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { createRuntimePaths, readConfigStatus } from "../config/index.js";
import { waitForRuntimeLockRelease } from "../service/lock.js";
import type { TwinnyConfig } from "../types.js";
import { createSystemdUserServiceUnit, systemdUnitNameForHomeRandom } from "./unit.js";

export interface SystemdUserServiceCommandOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InstallSystemdUserServiceOptions extends SystemdUserServiceCommandOptions {
  config?: TwinnyConfig;
  entrypoint?: string;
  environment?: Record<string, string | undefined>;
}

interface SystemdUserServiceRuntime {
  home: string;
  unitName: string;
  unitPath: string;
  config: TwinnyConfig;
}

export async function installSystemdUserService(options: InstallSystemdUserServiceOptions = {}): Promise<void> {
  const runtime = await resolveSystemdUserServiceRuntime(options);
  fs.mkdirSync(path.dirname(runtime.unitPath), { recursive: true });
  fs.writeFileSync(
    runtime.unitPath,
    createSystemdUserServiceUnit({
      unitName: runtime.unitName,
      twinnyHome: runtime.home,
      entrypoint: options.entrypoint,
      environment: options.environment
    }),
    "utf8"
  );
  await execa("systemctl", ["--user", "daemon-reload"]);
  await execa("systemctl", ["--user", "enable", runtime.unitName]);
  console.log(`Installed ${runtime.unitName} at ${runtime.unitPath}`);
}

export async function uninstallSystemdUserService(options: SystemdUserServiceCommandOptions = {}): Promise<void> {
  const runtime = await resolveSystemdUserServiceRuntime(options);
  await execa("systemctl", ["--user", "disable", "--now", runtime.unitName], { reject: false });
  if (fs.existsSync(runtime.unitPath)) {
    fs.rmSync(runtime.unitPath);
  }
  await execa("systemctl", ["--user", "daemon-reload"], { reject: false });
  console.log(`Uninstalled ${runtime.unitName}`);
}

export async function startSystemdUserService(options: SystemdUserServiceCommandOptions = {}): Promise<void> {
  const runtime = await resolveSystemdUserServiceRuntime(options);
  if (!fs.existsSync(runtime.unitPath)) {
    await installSystemdUserService(options);
  }
  await execa("systemctl", ["--user", "start", runtime.unitName]);
  console.log(`Started ${runtime.unitName}`);
}

export async function stopSystemdUserService(options: SystemdUserServiceCommandOptions = {}): Promise<void> {
  const runtime = await resolveSystemdUserServiceRuntime(options);
  await execa("systemctl", ["--user", "stop", runtime.unitName], { reject: false });
  await waitForRuntimeLockRelease({ home: runtime.home });
  console.log(`Stopped ${runtime.unitName}`);
}

export async function restartSystemdUserService(options: SystemdUserServiceCommandOptions = {}): Promise<void> {
  await stopSystemdUserService(options);
  await startSystemdUserService(options);
}

export async function statusSystemdUserService(options: SystemdUserServiceCommandOptions = {}): Promise<void> {
  const runtime = await resolveSystemdUserServiceRuntime(options);
  const result = await execa("systemctl", ["--user", "status", "--no-pager", "--full", runtime.unitName], {
    reject: false
  });
  if (result.exitCode === 0) {
    console.log(result.stdout);
    return;
  }
  console.log(result.stdout || result.stderr || `${runtime.unitName} is not loaded`);
}

export async function tailSystemdUserServiceLogs(options: SystemdUserServiceCommandOptions = {}): Promise<void> {
  const runtime = await resolveSystemdUserServiceRuntime(options);
  await execa("journalctl", ["--user", "-u", runtime.unitName, "-f"], { stdio: "inherit" });
}

function getSystemdUserServiceDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "systemd", "user");
}

async function resolveSystemdUserServiceRuntime(
  options: InstallSystemdUserServiceOptions = {}
): Promise<SystemdUserServiceRuntime> {
  const status = options.config
    ? { complete: true, issues: [], config: options.config, paths: createRuntimePaths(options.config.home) }
    : await readConfigStatus({ home: options.home });
  if (!status.complete || !status.config) {
    throw new Error(`Twinny home is not configured. Issues: ${status.issues.join("; ")}`);
  }
  const unitName = systemdUnitNameForHomeRandom(status.config.homeIdentity.random);
  return {
    home: status.paths.home,
    unitName,
    unitPath: path.join(getSystemdUserServiceDir(options.env), unitName),
    config: status.config
  };
}
