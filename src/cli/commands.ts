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

  program.command("install").description("Run the Twinny install wizard.").action(async () => {
    const { runInstallWizard } = await import("./install-wizard.js");
    await runInstallWizard();
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
