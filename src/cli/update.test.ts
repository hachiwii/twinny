import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapTwinnyHome, createTwinnyConfig } from "../config/index.js";
import { createLaunchAgentPlist, launchAgentLabelForHomeRandom } from "../launchd/plist.js";
import { createWindowsTaskLauncher, windowsTaskLauncherPath } from "../windows/task.js";
import { runUpdateCommand, twinnyRunnerBinaryPath, twinnyRunnerDir } from "./update.js";

type UpdateOptions = NonNullable<Parameters<typeof runUpdateCommand>[0]>;
type UpdateCommandRunner = NonNullable<UpdateOptions["runCommand"]>;
type RestartLaunchAgent = NonNullable<UpdateOptions["restartLaunchAgent"]>;
type RestartManagedService = NonNullable<UpdateOptions["restartManagedService"]>;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("update command", () => {
  it("defaults to the currently executing package version", async () => {
    const home = await configuredHome();
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const output = createOutput();
    const identity = await readPackageIdentity();

    await expect(runUpdateCommand({
      home,
      platform: "darwin",
      restart: false,
      runCommand: runCommand as unknown as UpdateCommandRunner,
      stdout: output.writer,
      launchAgentPlistPath: path.join(home, "missing.plist")
    })).resolves.toMatchObject({
      packageSpec: `${identity.name}@${identity.version}`
    });

    expect(runCommand).toHaveBeenCalledWith(
      "npm",
      ["install", "--prefix", twinnyRunnerDir(home), "--omit=dev", "--no-audit", "--no-fund", `${identity.name}@${identity.version}`],
      expect.objectContaining({ stdio: "pipe" })
    );
  });

  it("updates the home runner and restarts when LaunchAgent uses the runner", async () => {
    const home = await configuredHome();
    const plistPath = await writeLaunchAgentPlist(home, { entrypoint: twinnyRunnerBinaryPath(home) });
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const restartLaunchAgent = vi.fn(async () => undefined);
    const output = createOutput();

    await expect(runUpdateCommand({
      home,
      platform: "darwin",
      packageSpec: "twinny@latest",
      runCommand: runCommand as unknown as UpdateCommandRunner,
      restartLaunchAgent: restartLaunchAgent as unknown as RestartLaunchAgent,
      stdout: output.writer,
      launchAgentPlistPath: plistPath
    })).resolves.toMatchObject({
      home,
      runnerDir: twinnyRunnerDir(home),
      runnerBinary: twinnyRunnerBinaryPath(home),
      packageSpec: "twinny@latest",
      launchAgentUsesRunner: true,
      restarted: true
    });

    expect(runCommand).toHaveBeenCalledWith(
      "npm",
      ["install", "--prefix", twinnyRunnerDir(home), "--omit=dev", "--no-audit", "--no-fund", "twinny@latest"],
      expect.objectContaining({ stdio: "pipe" })
    );
    expect(restartLaunchAgent).toHaveBeenCalledWith({ home });
    expect(output.raw()).toContain("Updated Twinny runner");
    expect(output.raw()).toContain("Twinny restarted");
  });

  it("updates without restart when requested", async () => {
    const home = await configuredHome();
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const restartLaunchAgent = vi.fn(async () => undefined);
    const output = createOutput();

    await expect(runUpdateCommand({
      home,
      platform: "darwin",
      restart: false,
      packageSpec: "twinny@next",
      runCommand: runCommand as unknown as UpdateCommandRunner,
      restartLaunchAgent: restartLaunchAgent as unknown as RestartLaunchAgent,
      stdout: output.writer,
      launchAgentPlistPath: path.join(home, "missing.plist")
    })).resolves.toMatchObject({
      packageSpec: "twinny@next",
      launchAgentUsesRunner: false,
      restarted: false
    });

    expect(restartLaunchAgent).not.toHaveBeenCalled();
    expect(output.raw()).toContain("Skipped restart");
  });

  it("skips automatic restart when LaunchAgent does not use the runner", async () => {
    const home = await configuredHome();
    const plistPath = await writeLaunchAgentPlist(home, { entrypoint: "/usr/local/bin/twinny" });
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const restartLaunchAgent = vi.fn(async () => undefined);
    const output = createOutput();

    await expect(runUpdateCommand({
      home,
      platform: "darwin",
      packageSpec: "twinny@latest",
      runCommand: runCommand as unknown as UpdateCommandRunner,
      restartLaunchAgent: restartLaunchAgent as unknown as RestartLaunchAgent,
      stdout: output.writer,
      launchAgentPlistPath: plistPath
    })).resolves.toMatchObject({
      launchAgentUsesRunner: false,
      restarted: false
    });

    expect(restartLaunchAgent).not.toHaveBeenCalled();
    expect(output.raw()).toContain("does not use the Twinny runner");
  });

  it("restarts Windows scheduled task installations that use the runner", async () => {
    const home = await configuredHome();
    const runnerBinary = twinnyRunnerBinaryPath(home, "win32");
    const launcherPath = windowsTaskLauncherPath(home);
    await fs.mkdir(path.dirname(launcherPath), { recursive: true });
    await fs.writeFile(launcherPath, createWindowsTaskLauncher({
      twinnyHome: home,
      entrypoint: runnerBinary
    }), "utf8");
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const restartManagedService = vi.fn(async () => undefined);

    await expect(runUpdateCommand({
      home,
      platform: "win32",
      packageSpec: "twinny@latest",
      runCommand: runCommand as unknown as UpdateCommandRunner,
      restartManagedService: restartManagedService as unknown as RestartManagedService,
      stdout: createOutput().writer
    })).resolves.toMatchObject({
      runnerBinary,
      managedServiceUsesRunner: true,
      restarted: true
    });

    expect(restartManagedService).toHaveBeenCalledWith({ home, platform: "win32" });
  });
});

async function configuredHome(): Promise<string> {
  const home = await tempHome();
  const homeRandom = "0123456789abcdef0123456789abcdef";
  await bootstrapTwinnyHome(createTwinnyConfig({
    home,
    homeRandom,
    codex: { binary: "codex" },
    auth: {
      larkAppId: "cli_test",
      larkBrand: "feishu",
      ownerOpenId: "ou_owner",
      displayName: "Owner"
    },
    profiles: {
      host: {},
      guest: {}
    }
  }));
  return home;
}

async function writeLaunchAgentPlist(home: string, input: { entrypoint: string }): Promise<string> {
  const homeRandom = "0123456789abcdef0123456789abcdef";
  const label = launchAgentLabelForHomeRandom(homeRandom);
  const plistPath = path.join(home, `${label}.plist`);
  await fs.writeFile(plistPath, createLaunchAgentPlist({
    label,
    twinnyHome: home,
    entrypoint: input.entrypoint
  }), "utf8");
  return plistPath;
}

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-update-"));
  tempDirs.push(dir);
  return dir;
}

function createOutput(): {
  writer: UpdateOptions["stdout"];
  raw: () => string;
} {
  const chunks: string[] = [];
  return {
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      }
    } as UpdateOptions["stdout"],
    raw: () => chunks.join("")
  };
}

async function readPackageIdentity(): Promise<{ name: string; version: string }> {
  const raw = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
  return { name: raw.name, version: raw.version };
}
