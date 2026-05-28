import { describe, expect, it, vi } from "vitest";
import { isSystemdUserAvailable, isWsl2 } from "./detect.js";

type ReadFile = NonNullable<Parameters<typeof isWsl2>[0]>["readFile"];
type CommandRunner = NonNullable<Parameters<typeof isSystemdUserAvailable>[0]>["runCommand"];

describe("platform detection", () => {
  it("detects WSL2 from proc metadata", async () => {
    const readFile = vi.fn(async (filePath: string) => {
      if (filePath === "/proc/sys/kernel/osrelease") {
        return "5.15.167.4-microsoft-standard-WSL2";
      }
      return "Linux version";
    });

    await expect(isWsl2({
      platform: "linux",
      readFile: readFile as unknown as ReadFile
    })).resolves.toBe(true);
    await expect(isWsl2({
      platform: "darwin",
      readFile: readFile as unknown as ReadFile
    })).resolves.toBe(false);
  });

  it("checks whether systemd user services are available", async () => {
    const available = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const unavailable = vi.fn(async () => ({ stdout: "", stderr: "Failed to connect to bus", exitCode: 1 }));

    await expect(isSystemdUserAvailable({ runCommand: available as unknown as CommandRunner })).resolves.toBe(true);
    await expect(isSystemdUserAvailable({ runCommand: unavailable as unknown as CommandRunner })).resolves.toBe(false);
  });
});
