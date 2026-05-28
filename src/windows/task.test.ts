import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWindowsTaskLauncher,
  windowsTaskLauncherPath,
  windowsTaskNameForHomeRandom,
  windowsTaskUsesEntrypoint
} from "./task.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Windows scheduled task support", () => {
  it("creates a stable per-home scheduled task name", () => {
    expect(windowsTaskNameForHomeRandom("A".repeat(32))).toMatch(/^\\Twinny\\twinny-[a-f0-9]{16}$/);
    expect(windowsTaskNameForHomeRandom("A".repeat(32))).toBe(windowsTaskNameForHomeRandom("a".repeat(32)));
  });

  it("writes a launcher that runs Twinny and redirects logs", () => {
    const launcher = createWindowsTaskLauncher({
      twinnyHome: "C:\\Users\\tester\\.twinny",
      entrypoint: "C:\\Users\\tester\\.twinny\\runner\\node_modules\\.bin\\twinny.cmd",
      environment: {
        PATH: "C:\\Tools",
        TWINNY_HOME: "ignored",
        INVALID_KEY_NAME: "ignored"
      },
      logPath: "C:\\Users\\tester\\AppData\\Local\\Twinny\\logs\\twinny-task.log"
    });

    expect(launcher).toContain("set \"TWINNY_HOME=C:\\Users\\tester\\.twinny\"");
    expect(launcher).toContain("call \"C:\\Users\\tester\\.twinny\\runner\\node_modules\\.bin\\twinny.cmd\" run");
    expect(launcher).toContain(">> \"C:\\Users\\tester\\AppData\\Local\\Twinny\\logs\\twinny-task.log\" 2>&1");
  });

  it("detects whether a task launcher uses the runner binary", async () => {
    const home = await tempHome();
    const runner = path.join(home, "runner", "node_modules", ".bin", "twinny.cmd");
    await fs.mkdir(path.dirname(windowsTaskLauncherPath(home)), { recursive: true });
    await fs.writeFile(windowsTaskLauncherPath(home), createWindowsTaskLauncher({
      twinnyHome: home,
      entrypoint: runner
    }), "utf8");

    await expect(windowsTaskUsesEntrypoint({ home, entrypoint: runner })).resolves.toBe(true);
    await expect(windowsTaskUsesEntrypoint({ home, entrypoint: path.join(home, "other.cmd") })).resolves.toBe(false);
  });
});

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-windows-task-"));
  tempDirs.push(dir);
  return dir;
}
