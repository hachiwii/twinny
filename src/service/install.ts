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

export type ManagedServiceKind = "launchd" | "systemd";

export interface ManagedServiceCommandOptions extends LaunchAgentCommandOptions, SystemdUserServiceCommandOptions {
  platform?: NodeJS.Platform;
}

export interface InstallManagedServiceOptions
  extends Omit<InstallLaunchAgentOptions, "home">,
    Omit<InstallSystemdUserServiceOptions, "home">,
    ManagedServiceCommandOptions {}

export function managedServiceKindForPlatform(platform: NodeJS.Platform = process.platform): ManagedServiceKind {
  if (platform === "darwin") {
    return "launchd";
  }
  if (platform === "linux") {
    return "systemd";
  }
  throw new Error(
    `Twinny managed service is not supported on ${platform}. Supported service managers: macOS launchd, Linux systemd user services. Use \`twinny run\` to run in the foreground.`
  );
}

export function managedServiceDisplayName(platform: NodeJS.Platform = process.platform): string {
  return managedServiceKindForPlatform(platform) === "launchd" ? "LaunchAgent" : "systemd user service";
}

export async function installManagedService(options: InstallManagedServiceOptions = {}): Promise<void> {
  if (managedServiceKindForPlatform(options.platform) === "launchd") {
    await installLaunchAgent(options);
    return;
  }
  await installSystemdUserService(options);
}

export async function uninstallManagedService(options: ManagedServiceCommandOptions = {}): Promise<void> {
  if (managedServiceKindForPlatform(options.platform) === "launchd") {
    await uninstallLaunchAgent(options);
    return;
  }
  await uninstallSystemdUserService(options);
}

export async function startManagedService(options: ManagedServiceCommandOptions = {}): Promise<void> {
  if (managedServiceKindForPlatform(options.platform) === "launchd") {
    await startLaunchAgent(options);
    return;
  }
  await startSystemdUserService(options);
}

export async function stopManagedService(options: ManagedServiceCommandOptions = {}): Promise<void> {
  if (managedServiceKindForPlatform(options.platform) === "launchd") {
    await stopLaunchAgent(options);
    return;
  }
  await stopSystemdUserService(options);
}

export async function restartManagedService(options: ManagedServiceCommandOptions = {}): Promise<void> {
  if (managedServiceKindForPlatform(options.platform) === "launchd") {
    await restartLaunchAgent(options);
    return;
  }
  await restartSystemdUserService(options);
}

export async function statusManagedService(options: ManagedServiceCommandOptions = {}): Promise<void> {
  if (managedServiceKindForPlatform(options.platform) === "launchd") {
    await statusLaunchAgent(options);
    return;
  }
  await statusSystemdUserService(options);
}

export async function tailManagedServiceLogs(options: ManagedServiceCommandOptions = {}): Promise<void> {
  if (managedServiceKindForPlatform(options.platform) === "launchd") {
    await tailLaunchAgentLogs(options);
    return;
  }
  await tailSystemdUserServiceLogs(options);
}
