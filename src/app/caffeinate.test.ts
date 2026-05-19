import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { MacIdleSleepPreventer } from "./caffeinate.js";

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    });
    return true;
  }
}

describe("MacIdleSleepPreventer", () => {
  it("starts /usr/bin/caffeinate -i on macOS and stops it on shutdown", async () => {
    const child = new FakeChildProcess();
    const spawned: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
    const preventer = new MacIdleSleepPreventer({
      platform: "darwin",
      spawnProcess: (command, args, options) => {
        spawned.push({ command, args, options });
        return child as unknown as ChildProcess;
      }
    });

    preventer.start();
    preventer.start();

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      command: "/usr/bin/caffeinate",
      args: ["-i"],
      options: { stdio: "ignore" }
    });

    await preventer.stop();

    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("does not start caffeinate on non-macOS platforms", async () => {
    const preventer = new MacIdleSleepPreventer({
      platform: "linux",
      spawnProcess: () => {
        throw new Error("spawn should not be called");
      }
    });

    preventer.start();
    await expect(preventer.stop()).resolves.toBeUndefined();
  });

  it("allows caffeinate to be restarted after an unexpected exit", () => {
    const firstChild = new FakeChildProcess();
    const secondChild = new FakeChildProcess();
    const children = [firstChild, secondChild];
    const preventer = new MacIdleSleepPreventer({
      platform: "darwin",
      spawnProcess: () => children.shift() as unknown as ChildProcess
    });

    preventer.start();
    firstChild.exitCode = 1;
    firstChild.emit("exit", 1, null);
    preventer.start();

    expect(children).toHaveLength(0);
  });
});
