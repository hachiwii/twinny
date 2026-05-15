import { runFirstRunWizard } from "../wizard/first-run.js";
import { readConfigStatus } from "../config/index.js";
import { createRuntime, type TwinnyRuntime } from "./wiring.js";

export async function runDaemonCommand(): Promise<void> {
  let status = await readConfigStatus();
  if (!status.complete) {
    if (!process.stdin.isTTY) {
      throw new Error(`Twinny is not configured. Run "twinny wizard" first. Issues: ${status.issues.join("; ")}`);
    }
    await runFirstRunWizard();
    status = await readConfigStatus();
  }
  if (!status.config) {
    throw new Error("Twinny config could not be loaded after wizard");
  }

  const runtime = await createRuntime(status.config);
  installSignalHandlers(runtime);
  await runtime.start();
  await runtime.wait();
}

function installSignalHandlers(runtime: TwinnyRuntime): void {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shutdownPromise) {
      console.error(`Received ${signal} while shutdown is already in progress; forcing exit.`);
      process.exit(exitCodeForSignal(signal));
      return;
    }

    shutdownPromise = runtime
      .stop(signal)
      .then(() => {
        process.exit(process.exitCode ?? 0);
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
  };
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}
