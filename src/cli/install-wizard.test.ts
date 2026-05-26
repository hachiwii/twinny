import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryClient } from "../telemetry/index.js";
import { LARK_REQUIRED_SCOPES } from "../lark/index.js";
import {
  buildInstallGuideHtml,
  buildInstallGuideScopeImportJson,
  installGuideBotMenuActions,
  installGuideRequiredEvents,
  writeInstallGuidePage
} from "./install-guide.js";
import {
  assertInstallHomeIsEmpty,
  buildEnvSelection,
  buildServiceEnvironmentStats,
  compareSemver,
  defaultIncludeEnvKey,
  installWizardIntro,
  installWizardLarkBrand,
  isNpxEntrypoint,
  parseCodexVersion,
  readCodexDefaults,
  resolveServiceEntrypoint,
  runInstallWizard
} from "./install-wizard.js";

const tempDirs: string[] = [];
type ResolveServiceEntrypointOptions = NonNullable<Parameters<typeof resolveServiceEntrypoint>[1]>;
type NpmInstallRunner = NonNullable<ResolveServiceEntrypointOptions["runNpmInstall"]>;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("install wizard helpers", () => {
  it("keeps the installer scoped to Feishu", () => {
    expect(installWizardLarkBrand).toBe("feishu");
  });

  it("shows the Twinny rabbit in the install intro", () => {
    expect(installWizardIntro).toBe("🐰 Twinny install");
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
      CODEX_THREAD_ID: "thread",
      FOO: "bar",
      HTTPS_PROXY: "http://user:password@proxy.example:8080",
      OPENAI_API_KEY: "secret",
      PATH: "/usr/bin",
      PWD: "/tmp",
      SSH_CLIENT: "127.0.0.1 1 2",
      TERM: "xterm-256color",
      TWINNY_HOME: "/tmp/twinny"
    });

    expect(selection.options.map((option) => option.value)).toEqual(["CODEX_THREAD_ID", "FOO", "HTTPS_PROXY", "OPENAI_API_KEY", "PATH", "PWD", "SSH_CLIENT", "TERM"]);
    expect(selection.initialValues).toEqual(["FOO", "PATH"]);
    expect(defaultIncludeEnvKey("HTTPS_PROXY", "http://user:password@proxy.example:8080")).toBe(false);
    expect(defaultIncludeEnvKey("OPENAI_API_KEY")).toBe(false);
    expect(defaultIncludeEnvKey("SSH_CLIENT")).toBe(false);
    expect(defaultIncludeEnvKey("TERM")).toBe(false);
  });

  it("counts managed service environment keys for install telemetry", () => {
    const env = {
      FOO: "bar",
      PATH: "/usr/bin",
      OPENAI_API_KEY: "secret",
      TWINNY_HOME: "/old"
    };

    expect(buildServiceEnvironmentStats(env, {
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

  it("installs npx runner without writing through the active spinner", async () => {
    const home = await tempHome();
    const entrypoint = path.join(os.tmpdir(), "_npx", "abc", "node_modules", ".bin", "twinny");
    const runNpmInstallMock = vi.fn(async () => undefined);
    const packageJson = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      name: string;
      version: string;
    };

    const result = await resolveServiceEntrypoint(home, {
      entrypoint,
      runNpmInstall: runNpmInstallMock as unknown as NpmInstallRunner
    });

    expect(result).toBe(path.join(home, "runner", "node_modules", ".bin", "twinny"));
    expect(runNpmInstallMock).toHaveBeenCalledWith(
      "npm",
      ["install", "--prefix", path.join(home, "runner"), "--omit=dev", "--no-audit", "--no-fund", `${packageJson.name}@${packageJson.version}`],
      expect.objectContaining({ stdio: "pipe" })
    );
  });

  it("builds the install guide permission import JSON from doctor scopes", () => {
    expect(JSON.parse(buildInstallGuideScopeImportJson())).toEqual({
      scopes: {
        tenant: [...LARK_REQUIRED_SCOPES]
      }
    });
  });

  it("renders install guide links, events, and menu actions", () => {
    const html = buildInstallGuideHtml("cli_test/app", { logoDataUri: "data:image/png;base64,abc" });

    expect(html).toContain("data:image/png;base64,abc");
    expect(html).toContain("https://open.larkoffice.com/app/cli_test%2Fapp/auth");
    expect(html).toContain("https://open.larkoffice.com/app/cli_test%2Fapp/event");
    expect(html).toContain("https://open.larkoffice.com/app/cli_test%2Fapp/bot");
    expect(html).toContain("<h3>事件</h3>");
    expect(html).toContain("<h3>回调</h3>");
    expect(html.match(/<table class="config-table">/g)).toHaveLength(2);
    expect(html).not.toContain("权限列表与");
    expect(html).not.toContain("new_session");
    for (const item of installGuideRequiredEvents) {
      expect(html).toContain(item.event);
    }
    for (const item of installGuideBotMenuActions) {
      expect(html).toContain(item.eventKey);
    }
    expect(installGuideBotMenuActions.map((item) => item.eventKey)).not.toContain("new_session");
  });

  it("writes the install guide page as a local file", async () => {
    const outputDir = await tempHome();

    const page = await writeInstallGuidePage("cli_test", { outputDir });

    expect(page.filePath).toBe(path.join(outputDir, "index.html"));
    expect(page.fileUrl).toMatch(/^file:\/\//);
    const html = await fs.readFile(page.filePath, "utf8");
    expect(html).toContain("data:image/png;base64");
    expect(html).toContain("https://open.larkoffice.com/app/cli_test/auth");
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
