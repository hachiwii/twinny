import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Logger } from "pino";

export interface IdleSleepPreventer {
  start(): void;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export interface MacIdleSleepPreventerOptions {
  logger?: Pick<Logger, "info" | "warn">;
  platform?: NodeJS.Platform;
  command?: string;
  args?: string[];
  stopTimeoutMs?: number;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export const DEFAULT_CAFFEINATE_COMMAND = "/usr/bin/caffeinate";
const defaultCaffeinateArgs = ["-i"];

export class MacIdleSleepPreventer implements IdleSleepPreventer {
  private readonly platform: NodeJS.Platform;
  private readonly command: string;
  private readonly args: string[];
  private readonly stopTimeoutMs: number;
  private readonly spawnProcess: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  private child?: ChildProcess;
  private stopping = false;

  constructor(private readonly options: MacIdleSleepPreventerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.command = options.command ?? DEFAULT_CAFFEINATE_COMMAND;
    this.args = options.args ?? defaultCaffeinateArgs;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 1_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  start(): void {
    if (this.platform !== "darwin" || this.child) {
      return;
    }

    this.stopping = false;
    let child: ChildProcess;
    try {
      child = this.spawnProcess(this.command, this.args, {
        stdio: "ignore"
      });
    } catch (error) {
      this.options.logger?.warn({ error, command: this.command, args: this.args }, "failed to start caffeinate");
      return;
    }

    this.child = child;
    child.once("error", (error) => {
      if (this.child === child) {
        this.child = undefined;
      }
      if (!this.stopping) {
        this.options.logger?.warn({ error, command: this.command, args: this.args }, "failed to start caffeinate");
      }
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) {
        this.child = undefined;
      }
      if (!this.stopping) {
        this.options.logger?.warn({ code, signal }, "caffeinate exited before twinny daemon shutdown");
      }
    });

    this.options.logger?.info({ command: this.command, args: this.args }, "started caffeinate idle sleep assertion");
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    if (!child) {
      return;
    }

    if (!hasExited(child) && !child.killed) {
      child.kill(signal);
    }

    const stopped = await waitForChildExit(child, this.stopTimeoutMs);
    if (!stopped && !hasExited(child)) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 1_000);
    }
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    timeout.unref?.();

    const onExit = (): void => {
      cleanup();
      resolve(true);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };

    child.once("exit", onExit);
  });
}
