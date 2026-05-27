import { Command } from "commander";
import { TWINNY_VERSION } from "../version.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("twinny")
    .description("Bridge Lark p2p messages to Codex app-server threads.")
    .version(TWINNY_VERSION);

  program.command("run").description("Run the daemon in the foreground.").action(async () => {
    const { runDaemonCommand } = await import("../app/daemon.js");
    await runDaemonCommand();
  });

  program.command("doctor").description("Check local Twinny, Lark, and Codex configuration.").action(async () => {
    const { runDoctorCommand } = await import("../observability/health.js");
    await runDoctorCommand();
  });

  program
    .command("update")
    .description("Update the installed Twinny runner.")
    .option("--no-restart", "Update without restarting Twinny.")
    .action(async (options: { restart?: boolean }) => {
      const { runUpdateCommand } = await import("./update.js");
      await runUpdateCommand({ restart: options.restart !== false });
    });

  const install = program.command("install").description("Run the Twinny install wizard.");
  install
    .option("--disable-keychain", "Store the Lark app secret in auth.json instead of macOS Keychain.")
    .option("--no-gui", "Install the macOS service as a LaunchDaemon instead of a GUI LaunchAgent.")
    .action(async (options: { disableKeychain?: boolean; gui?: boolean }) => {
      const { runInstallWizard } = await import("./install-wizard.js");
      await runInstallWizard({ disableKeychain: Boolean(options.disableKeychain), noGui: options.gui === false });
    });
  install
    .command("agent")
    .description("Run the non-interactive Twinny install flow for agents.")
    .option("--env-mode <mode>", "Environment import mode: default, manual, or none.", "default")
    .option("--env-key <key>", "Environment key to import when --env-mode manual is used.", collectOption, [])
    .option("--install-codex <mode>", "Codex install behavior: auto or never.", "auto")
    .option("--install-lark-cli <mode>", "lark-cli install behavior: auto or never.", "auto")
    .option("--start <value>", "Whether to start Twinny after installing: true or false.", "true")
    .option("--disable-keychain", "Store the Lark app secret in auth.json instead of macOS Keychain.")
    .option("--no-gui", "Install the macOS service as a LaunchDaemon instead of a GUI LaunchAgent.")
    .action(async (options: {
      envMode: string;
      envKey: string[];
      installCodex: string;
      installLarkCli: string;
      start: string;
      disableKeychain?: boolean;
      gui?: boolean;
    }, command: Command) => {
      const parentOptions = command.parent?.opts<{ disableKeychain?: boolean; gui?: boolean }>() ?? {};
      const { runInstallAgent } = await import("./install-wizard.js");
      await runInstallAgent({
        envMode: parseChoice(options.envMode, ["default", "manual", "none"], "--env-mode"),
        envKeys: options.envKey,
        installCodex: parseChoice(options.installCodex, ["auto", "never"], "--install-codex"),
        installLarkCli: parseChoice(options.installLarkCli, ["auto", "never"], "--install-lark-cli"),
        start: parseBooleanOption(options.start, "--start"),
        disableKeychain: Boolean(options.disableKeychain || parentOptions.disableKeychain),
        noGui: options.gui === false || parentOptions.gui === false
      });
    });

  program.command("uninstall").description("Uninstall the managed daemon service.").action(async () => {
    const { uninstallManagedService } = await import("../service/index.js");
    await uninstallManagedService();
  });

  program.command("start").description("Start the managed daemon service.").action(async () => {
    const { startManagedService } = await import("../service/index.js");
    await startManagedService();
  });

  program.command("stop").description("Stop the managed daemon service.").action(async () => {
    const { stopManagedService } = await import("../service/index.js");
    await stopManagedService();
  });

  program.command("restart").description("Restart the managed daemon service.").action(async () => {
    const { restartManagedService } = await import("../service/index.js");
    await restartManagedService();
  });

  program.command("status").description("Show daemon status.").action(async () => {
    const { statusManagedService } = await import("../service/index.js");
    await statusManagedService();
  });

  program.command("logs").description("Tail Twinny logs.").action(async () => {
    const { tailManagedServiceLogs } = await import("../service/index.js");
    await tailManagedServiceLogs();
  });

  await program.parseAsync(argv);
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseChoice<const T extends readonly string[]>(value: string, allowed: T, optionName: string): T[number] {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  throw new Error(`${optionName} must be one of: ${allowed.join(", ")}`);
}

function parseBooleanOption(value: string, optionName: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${optionName} must be true or false`);
}
