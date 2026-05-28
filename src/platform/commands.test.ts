import { describe, expect, it, vi } from "vitest";
import { commandForPlatform, npmBinNameForPlatform, resolveExecutable } from "./commands.js";

type ResolveExecutableRunner = NonNullable<Parameters<typeof resolveExecutable>[1]>["runCommand"];

describe("platform commands", () => {
  it("uses which on Unix and where on Windows", async () => {
    const runCommand = vi.fn(async (command: string) => ({
      stdout: command === "where" ? "C:\\Tools\\codex.cmd\r\n" : "/usr/local/bin/codex\n",
      stderr: "",
      exitCode: 0
    }));

    await expect(resolveExecutable("codex", {
      platform: "linux",
      runCommand: runCommand as unknown as ResolveExecutableRunner
    })).resolves.toBe("/usr/local/bin/codex");
    await expect(resolveExecutable("codex", {
      platform: "win32",
      runCommand: runCommand as unknown as ResolveExecutableRunner
    })).resolves.toBe("C:\\Tools\\codex.cmd");

    expect(runCommand).toHaveBeenNthCalledWith(1, "which", ["codex"], expect.objectContaining({ reject: false }));
    expect(runCommand).toHaveBeenNthCalledWith(2, "where", ["codex"], expect.objectContaining({ reject: false }));
  });

  it("uses .cmd npm bins and wraps Windows command shims", () => {
    expect(npmBinNameForPlatform("twinny", "win32")).toBe("twinny.cmd");
    expect(npmBinNameForPlatform("twinny", "linux")).toBe("twinny");

    expect(commandForPlatform("C:\\Tools\\codex.cmd", ["login", "status"], "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "\"C:\\Tools\\codex.cmd\" \"login\" \"status\""]
    });
    expect(commandForPlatform("/usr/local/bin/codex", ["--version"], "linux")).toEqual({
      command: "/usr/local/bin/codex",
      args: ["--version"]
    });
  });
});
