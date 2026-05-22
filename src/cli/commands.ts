import { Command } from "commander";
import { TWINNY_VERSION } from "../version.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("twinny")
    .description("Bridge Lark p2p messages to Codex app-server threads.")
    .version(TWINNY_VERSION);

  program.command("wizard").description("Initialize Twinny configuration.").action(async () => {
    const { runWizardCommand } = await import("../wizard/first-run.js");
    await runWizardCommand();
  });

  program.command("run").description("Run the daemon in the foreground.").action(async () => {
    const { runDaemonCommand } = await import("../app/daemon.js");
    await runDaemonCommand();
  });

  program.command("doctor").description("Check local Twinny, Lark, and Codex configuration.").action(async () => {
    const { runDoctorCommand } = await import("../observability/health.js");
    await runDoctorCommand();
  });

  program.command("install").description("Install the macOS LaunchAgent.").action(async () => {
    const { installLaunchAgent } = await import("../launchd/install.js");
    await installLaunchAgent();
  });

  program.command("uninstall").description("Uninstall the macOS LaunchAgent.").action(async () => {
    const { uninstallLaunchAgent } = await import("../launchd/install.js");
    await uninstallLaunchAgent();
  });

  program.command("start").description("Start the LaunchAgent.").action(async () => {
    const { startLaunchAgent } = await import("../launchd/install.js");
    await startLaunchAgent();
  });

  program.command("stop").description("Stop the LaunchAgent.").action(async () => {
    const { stopLaunchAgent } = await import("../launchd/install.js");
    await stopLaunchAgent();
  });

  program.command("restart").description("Restart the LaunchAgent.").action(async () => {
    const { restartLaunchAgent } = await import("../launchd/install.js");
    await restartLaunchAgent();
  });

  program.command("status").description("Show daemon status.").action(async () => {
    const { statusLaunchAgent } = await import("../launchd/install.js");
    await statusLaunchAgent();
  });

  program.command("logs").description("Tail Twinny logs.").action(async () => {
    const { tailLogs } = await import("../launchd/install.js");
    await tailLogs();
  });

  await program.parseAsync(argv);
}
