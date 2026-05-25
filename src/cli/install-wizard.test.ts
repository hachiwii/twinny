import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryClient } from "../telemetry/index.js";
import {
  assertInstallHomeIsEmpty,
  buildEnvSelection,
  buildLaunchEnvironmentStats,
  compareSemver,
  defaultIncludeEnvKey,
  installWizardLarkBrand,
  isNpxEntrypoint,
  parseCodexVersion,
  readCodexDefaults,
  runInstallWizard
} from "./install-wizard.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("install wizard helpers", () => {
  it("keeps the installer scoped to Feishu", () => {
    expect(installWizardLarkBrand).toBe("feishu");
  });

  it("parses and compares Codex versions", () => {
    expect(parseCodexVersion("codex 0.130.0")).toBe("0.130.0");
    expect(parseCodexVersion("codex-cli 0.131.2+build.4")).toBe("0.131.2+build.4");
    expect(parseCodexVersion("unknown")).toBeUndefined();
    expect(compareSemver("0.130.0", "0.130.0")).toBe(0);
    expect(compareSemver("0.130.1", "0.130.0")).toBeGreaterThan(0);
    expect(compareSemver("0.129.9", "0.130.0")).toBeLessThan(0);
  });

  it("requires the target home to be missing or empty", async () => {
    const missing = path.join(os.tmpdir(), `twinny-missing-${Date.now()}`);
    const empty = await tempHome();
    const nonEmpty = await tempHome();
    await fs.writeFile(path.join(nonEmpty, "config.toml"), "");

    await expect(assertInstallHomeIsEmpty(missing)).resolves.toBeUndefined();
    await expect(assertInstallHomeIsEmpty(empty)).resolves.toBeUndefined();
    await expect(assertInstallHomeIsEmpty(nonEmpty)).rejects.toThrow(/TWINNY_HOME is not empty/);
  });

  it("selects launch environment defaults without sensitive or terminal session variables", () => {
    const selection = buildEnvSelection({
      FOO: "bar",
      OPENAI_API_KEY: "secret",
      PATH: "/usr/bin",
      PWD: "/tmp",
      TERM: "xterm-256color",
      TWINNY_HOME: "/tmp/twinny"
    });

    expect(selection.options.map((option) => option.value)).toEqual(["FOO", "OPENAI_API_KEY", "PATH", "PWD", "TERM"]);
    expect(selection.initialValues).toEqual(["FOO", "PATH"]);
    expect(defaultIncludeEnvKey("OPENAI_API_KEY")).toBe(false);
    expect(defaultIncludeEnvKey("TERM")).toBe(false);
  });

  it("counts LaunchAgent environment keys for install telemetry", () => {
    const env = {
      FOO: "bar",
      PATH: "/usr/bin",
      OPENAI_API_KEY: "secret",
      TWINNY_HOME: "/old"
    };

    expect(buildLaunchEnvironmentStats(env, {
      FOO: "bar",
      TWINNY_HOME: "/new",
      TWINNY_PROFILE: "host"
    })).toEqual({
      importedEnvKeyCount: 3,
      candidateEnvKeyCount: 3,
      defaultIncludedEnvKeyCount: 2
    });
  });

  it("reports non-TTY install attempts to telemetry when a reporter is available", async () => {
    const telemetry = createTelemetry();

    await expect(runInstallWizard({ telemetry, stdinIsTTY: false, stdoutIsTTY: true })).rejects.toThrow(/interactive terminal/);

    expect(telemetry.captureError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
      errorType: "install",
      errorSite: "cli.runInstallWizard",
      fatal: true,
      properties: expect.objectContaining({
        stdin_is_tty: false,
        stdout_is_tty: true,
        tty_mode: "non_tty"
      })
    }));
  });

  it("reads Codex model defaults from ~/.codex/config.toml", async () => {
    const home = await tempHome();
    await fs.mkdir(path.join(home, ".codex"));
    await fs.writeFile(path.join(home, ".codex", "config.toml"), 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n');

    await expect(readCodexDefaults(home)).resolves.toEqual({ model: "gpt-5.4", effort: "high" });
    await expect(readCodexDefaults(path.join(home, "missing"))).resolves.toEqual({ model: "gpt-5.5", effort: "medium" });
  });

  it("detects npx entrypoints", () => {
    expect(isNpxEntrypoint(path.join(os.tmpdir(), "_npx", "abc", "node_modules", ".bin", "twinny"))).toBe(true);
    expect(isNpxEntrypoint("/usr/local/bin/twinny")).toBe(false);
  });
});

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-install-wizard-"));
  tempDirs.push(dir);
  return dir;
}

function createTelemetry(): TelemetryClient {
  return {
    runtimeId: "runtime_test",
    capture: vi.fn(),
    captureError: vi.fn(),
    hashId: vi.fn((kind, raw) => raw ? `hashed:${kind}:${raw.length}` : null)
  };
}
