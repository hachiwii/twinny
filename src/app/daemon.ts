import fs from "node:fs/promises";
import { readConfigStatus } from "../config/index.js";
import { createRuntime, type TwinnyRuntime } from "./wiring.js";

export async function runDaemonCommand(): Promise<void> {
  const status = await readConfigStatus();
  if (!status.complete) {
    throw new Error(`Twinny home is not configured. Issues: ${status.issues.join("; ")}`);
  }
  if (!status.config) {
    throw new Error("Twinny config could not be loaded");
  }
  if (await fileExists(`${status.paths.runtimeDir}/upgrade-in-progress`)) {
    console.error("Twinny upgrade is in progress; exiting so the update helper can finish.");
    return;
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

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}
