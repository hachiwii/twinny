import { describe, expect, it } from "vitest";
import {
  managedServiceDisplayName,
  managedServiceDisplayNameForKind,
  managedServiceKindForPlatform,
  resolveManagedServiceKind
} from "./install.js";

describe("managed service routing", () => {
  it("uses launchd on macOS, systemd on Linux, and Task Scheduler on Windows", () => {
    expect(managedServiceKindForPlatform("darwin")).toBe("launchd");
    expect(managedServiceDisplayName("darwin")).toBe("LaunchAgent");
    expect(managedServiceKindForPlatform("linux")).toBe("systemd");
    expect(managedServiceDisplayName("linux")).toBe("systemd user service");
    expect(managedServiceKindForPlatform("win32")).toBe("windows-task");
    expect(managedServiceDisplayName("win32")).toBe("Windows scheduled task");
  });

  it("falls back to foreground run on WSL2 without systemd", async () => {
    const readFile = async (filePath: string) => {
      if (filePath === "/proc/sys/kernel/osrelease") {
        return "5.15.167.4-microsoft-standard-WSL2";
      }
      return "";
    };
    const runCommand = async () => ({ stdout: "", stderr: "not available", exitCode: 1 });

    await expect(resolveManagedServiceKind({
      platform: "linux",
      readFile: readFile as typeof import("node:fs/promises").readFile,
      runCommand: runCommand as never
    })).resolves.toBe("manual");
    expect(managedServiceDisplayNameForKind("manual")).toBe("foreground run");
  });

  it("reports unsupported platforms with a foreground-run fallback", () => {
    expect(() => managedServiceKindForPlatform("aix")).toThrow(/Use `twinny run` to run in the foreground/);
  });
});
