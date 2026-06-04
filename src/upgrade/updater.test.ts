import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTwinnyConfig } from "../config/index.js";
import { checkForTwinnyUpgrade, prepareAndScheduleTwinnyUpgrade } from "./updater.js";

type RunCommand = NonNullable<Parameters<typeof checkForTwinnyUpgrade>[0]["runCommand"]>;

const tempDirs: string[] = [];
const tempFiles: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  await Promise.all(tempFiles.splice(0).map((file) => fs.rm(file, { force: true })));
});

describe("Twinny updater", () => {
  it("checks npm dist-tags with the configured registry", async () => {
    const runCommand = npmMetadataCommand({
      latest: "1.2.0",
      time: { "1.2.0": "2026-06-05T01:02:03.000Z" }
    });

    const result = await checkForTwinnyUpgrade({
      currentVersion: "1.1.0",
      channel: "stable",
      registry: "https://registry.example.test",
      runCommand
    });

    expect(result).toMatchObject({
      currentVersion: "1.1.0",
      currentVersionValid: true,
      candidateVersion: "1.2.0",
      candidatePublishTime: "2026-06-05T01:02:03.000Z",
      tag: "latest",
      updateAvailable: true
    });
    expect(runCommand).toHaveBeenCalledWith(
      "npm",
      ["view", "twinny", "dist-tags", "time", "versions", "--json", "--registry", "https://registry.example.test"],
      expect.objectContaining({ stdio: "pipe" })
    );
  });

  it("disables upgrade decisions when the current version format is invalid", async () => {
    const result = await checkForTwinnyUpgrade({
      currentVersion: "dev",
      channel: "beta",
      runCommand: npmMetadataCommand({
        beta: "1.2.0-20260605010101",
        time: { "1.2.0-20260605010101": "2026-06-05T01:02:03.000Z" }
      })
    });

    expect(result).toMatchObject({
      currentVersionValid: false,
      candidateVersion: "1.2.0-20260605010101",
      disabledReason: "invalid-current-version",
      updateAvailable: false
    });
  });

  it("downloads the target version and writes a detached apply helper without spawning in tests", async () => {
    const home = await tempHome();
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "npm" && args[0] === "view") {
        return {
          stdout: JSON.stringify({
            "dist-tags": { latest: "1.2.0" },
            time: { "1.2.0": "2026-06-05T01:02:03.000Z" }
          }),
          stderr: "",
          exitCode: 0
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = await prepareAndScheduleTwinnyUpgrade({
      config: createConfig(home),
      currentVersion: "1.1.0",
      channel: "stable",
      registry: "https://registry.example.test",
      runCommand: runCommand as unknown as RunCommand,
      platform: "darwin",
      spawnHelper: false,
      verifyManagedServiceUsesRunner: false
    });

    expect(result.kind).toBe("scheduled");
    if (result.kind !== "scheduled") {
      throw new Error("expected scheduled result");
    }
    tempFiles.push(result.helperLogFile);
    expect(runCommand).toHaveBeenCalledWith(
      "npm",
      [
        "install",
        "--prefix",
        result.preparedRunnerDir,
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "twinny@1.2.0",
        "--registry",
        "https://registry.example.test"
      ],
      expect.objectContaining({ stdio: "pipe" })
    );
    const helper = await fs.readFile(result.helperScriptFile, "utf8");
    expect(helper).toContain('"action": "upgrade"');
    expect(helper).toContain('"targetVersion": "1.2.0"');
    expect(helper).toContain("backupSqlite");
    expect(helper).toContain("rollbackUpgrade");
    await expect(execa(process.execPath, ["--check", result.helperScriptFile])).resolves.toMatchObject({ exitCode: 0 });
  });

  it("does not download when the dist-tag is not newer", async () => {
    const runCommand = npmMetadataCommand({ latest: "1.1.0", time: { "1.1.0": "2026-06-05T01:02:03.000Z" } });
    const home = await tempHome();

    const result = await prepareAndScheduleTwinnyUpgrade({
      config: createConfig(home),
      currentVersion: "1.1.0",
      channel: "stable",
      runCommand,
      spawnHelper: false,
      verifyManagedServiceUsesRunner: false
    });

    expect(result.kind).toBe("no_update");
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("refuses to schedule when the managed service is not using the runner", async () => {
    const home = await tempHome();
    const runCommand = npmMetadataThenInstallCommand("1.2.0");

    await expect(prepareAndScheduleTwinnyUpgrade({
      config: createConfig(home),
      currentVersion: "1.1.0",
      channel: "stable",
      runCommand,
      platform: "darwin",
      spawnHelper: false
    })).rejects.toThrow("当前托管服务没有使用 Twinny runner");
  });
});

function npmMetadataCommand(input: {
  latest?: string;
  beta?: string;
  time?: Record<string, string>;
}): RunCommand {
  return vi.fn(async () => ({
    stdout: JSON.stringify({
      "dist-tags": {
        ...(input.latest ? { latest: input.latest } : {}),
        ...(input.beta ? { beta: input.beta } : {})
      },
      time: input.time ?? {}
    }),
    stderr: "",
    exitCode: 0
  })) as unknown as RunCommand;
}

function npmMetadataThenInstallCommand(version: string): RunCommand {
  return vi.fn(async (command: string, args: string[]) => {
    if (command === "npm" && args[0] === "view") {
      return {
        stdout: JSON.stringify({
          "dist-tags": { latest: version },
          time: { [version]: "2026-06-05T01:02:03.000Z" }
        }),
        stderr: "",
        exitCode: 0
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }) as unknown as RunCommand;
}

async function tempHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-updater-"));
  tempDirs.push(home);
  return home;
}

function createConfig(home: string) {
  return createTwinnyConfig({
    home,
    homeRandom: "0123456789abcdef0123456789abcdef",
    auth: { larkAppId: "cli_test", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner" },
    profiles: {
      host: {},
      guest: {}
    }
  });
}
