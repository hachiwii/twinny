import {
  installLaunchAgent,
  restartLaunchAgent,
  startLaunchAgent,
  statusLaunchAgent,
  stopLaunchAgent,
  tailLogs as tailLaunchAgentLogs,
  uninstallLaunchAgent,
  type InstallLaunchAgentOptions,
  type LaunchAgentCommandOptions
} from "../launchd/install.js";
import {
  installSystemdUserService,
  restartSystemdUserService,
  startSystemdUserService,
  statusSystemdUserService,
  stopSystemdUserService,
  tailSystemdUserServiceLogs,
  uninstallSystemdUserService,
  type InstallSystemdUserServiceOptions,
  type SystemdUserServiceCommandOptions
} from "../systemd/install.js";
import { isSystemdUserAvailable, isWsl2, type PlatformDetectionOptions } from "../platform/detect.js";
import {
  installWindowsTask,
  restartWindowsTask,
  startWindowsTask,
  statusWindowsTask,
  stopWindowsTask,
  tailWindowsTaskLogs,
  uninstallWindowsTask,
  type InstallWindowsTaskOptions,
  type WindowsTaskCommandOptions
} from "../windows/task.js";
import {
  installManualService,
  restartManualService,
  startManualService,
  statusManualService,
  stopManualService,
  tailManualServiceLogs,
  uninstallManualService
} from "./manual.js";

export type ManagedServiceKind = "launchd" | "systemd" | "windows-task" | "manual";

export interface ManagedServiceCommandOptions
  extends LaunchAgentCommandOptions,
    SystemdUserServiceCommandOptions,
    WindowsTaskCommandOptions,
    PlatformDetectionOptions {
  platform?: NodeJS.Platform;
}

export interface InstallManagedServiceOptions
  extends Omit<InstallLaunchAgentOptions, "home">,
    Omit<InstallSystemdUserServiceOptions, "home">,
    Omit<InstallWindowsTaskOptions, "home">,
    ManagedServiceCommandOptions {}

export function managedServiceKindForPlatform(platform: NodeJS.Platform = process.platform): ManagedServiceKind {
  if (platform === "darwin") {
    return "launchd";
  }
  if (platform === "linux") {
    return "systemd";
  }
  if (platform === "win32") {
    return "windows-task";
  }
  throw new Error(
    `Twinny managed service is not supported on ${platform}. Supported service managers: macOS launchd, Linux systemd user services, Windows Task Scheduler. Use \`twinny run\` to run in the foreground.`
  );
}

export async function resolveManagedServiceKind(options: ManagedServiceCommandOptions = {}): Promise<ManagedServiceKind> {
  const platform = options.platform ?? process.platform;
  const kind = managedServiceKindForPlatform(platform);
  if (kind !== "systemd") {
    return kind;
  }
  if (!(await isWsl2(options))) {
    return kind;
  }
  return await isSystemdUserAvailable(options) ? "systemd" : "manual";
}

export function managedServiceDisplayName(platform: NodeJS.Platform = process.platform): string {
  return managedServiceDisplayNameForKind(managedServiceKindForPlatform(platform));
}

export function managedServiceDisplayNameForKind(kind: ManagedServiceKind): string {
  switch (kind) {
    case "launchd":
      return "LaunchAgent";
    case "systemd":
      return "systemd user service";
    case "windows-task":
      return "Windows scheduled task";
    case "manual":
      return "foreground run";
  }
}

export async function installManagedService(options: InstallManagedServiceOptions = {}): Promise<void> {
  switch (await resolveManagedServiceKind(options)) {
    case "launchd":
      await installLaunchAgent(options);
      return;
    case "systemd":
      await installSystemdUserService(options);
      return;
    case "windows-task":
      await installWindowsTask(options);
      return;
    case "manual":
      await installManualService();
      return;
  }
}

export async function uninstallManagedService(options: ManagedServiceCommandOptions = {}): Promise<void> {
  switch (await resolveManagedServiceKind(options)) {
    case "launchd":
      await uninstallLaunchAgent(options);
      return;
    case "systemd":
      await uninstallSystemdUserService(options);
      return;
    case "windows-task":
      await uninstallWindowsTask(options);
      return;
    case "manual":
      await uninstallManualService();
      return;
  }
}

export async function startManagedService(options: ManagedServiceCommandOptions = {}): Promise<void> {
  switch (await resolveManagedServiceKind(options)) {
    case "launchd":
      await startLaunchAgent(options);
      return;
    case "systemd":
      await startSystemdUserService(options);
      return;
    case "windows-task":
      await startWindowsTask(options);
      return;
    case "manual":
      await startManualService();
      return;
  }
}

export async function stopManagedService(options: ManagedServiceCommandOptions = {}): Promise<void> {
  switch (await resolveManagedServiceKind(options)) {
    case "launchd":
      await stopLaunchAgent(options);
      return;
    case "systemd":
      await stopSystemdUserService(options);
      return;
    case "windows-task":
      await stopWindowsTask(options);
      return;
    case "manual":
      await stopManualService();
      return;
  }
}

export async function restartManagedService(options: ManagedServiceCommandOptions = {}): Promise<void> {
  switch (await resolveManagedServiceKind(options)) {
    case "launchd":
      await restartLaunchAgent(options);
      return;
    case "systemd":
      await restartSystemdUserService(options);
      return;
    case "windows-task":
      await restartWindowsTask(options);
      return;
    case "manual":
      await restartManualService();
      return;
  }
}

export async function statusManagedService(options: ManagedServiceCommandOptions = {}): Promise<void> {
  switch (await resolveManagedServiceKind(options)) {
    case "launchd":
      await statusLaunchAgent(options);
      return;
    case "systemd":
      await statusSystemdUserService(options);
      return;
    case "windows-task":
      await statusWindowsTask(options);
      return;
    case "manual":
      await statusManualService();
      return;
  }
}

export async function tailManagedServiceLogs(options: ManagedServiceCommandOptions = {}): Promise<void> {
  switch (await resolveManagedServiceKind(options)) {
    case "launchd":
      await tailLaunchAgentLogs(options);
      return;
    case "systemd":
      await tailSystemdUserServiceLogs(options);
      return;
    case "windows-task":
      await tailWindowsTaskLogs(options);
      return;
    case "manual":
      await tailManualServiceLogs();
      return;
  }
}
