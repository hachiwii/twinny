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
  buildServiceEnvironmentForChoice,
  buildServiceEnvironmentStats,
  checkCodexLoginStatus,
  compareSemver,
  defaultIncludeEnvKey,
  detectCodexBinary,
  detectLarkCliBinary,
  ensureLarkCliProfile,
  installCodexCli,
  installLarkCli,
  installWizardIntro,
  installWizardLarkBrand,
  isCodexLoggedInOutput,
  isNpxEntrypoint,
  parseCodexVersion,
  parseLarkCliProfileList,
  readCodexDefaults,
  resolveServiceEntrypoint,
  runInstallAgent,
  runInstallWizard
} from "./install-wizard.js";

const tempDirs: string[] = [];
type ResolveServiceEntrypointOptions = NonNullable<Parameters<typeof resolveServiceEntrypoint>[1]>;
type NpmInstallRunner = NonNullable<ResolveServiceEntrypointOptions["runNpmInstall"]>;
type CodexCommandRunner = NonNullable<Parameters<typeof detectCodexBinary>[1]>["runCommand"];
type LarkCliProfileRunner = NonNullable<Parameters<typeof ensureLarkCliProfile>[0]>["runCommand"];
type LarkCliDetectRunner = NonNullable<Parameters<typeof detectLarkCliBinary>[0]>["runCommand"];

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

  it("builds default, manual, and empty managed service environments", () => {
    const env = {
      FOO: "bar",
      PATH: "/usr/bin",
      OPENAI_API_KEY: "secret",
      TWINNY_PROFILE: "host"
    };

    expect(buildServiceEnvironmentForChoice("/tmp/twinny", env, "default").environment).toEqual({
      FOO: "bar",
      PATH: "/usr/bin",
      TWINNY_HOME: "/tmp/twinny",
      TWINNY_PROFILE: "host"
    });
    expect(buildServiceEnvironmentForChoice("/tmp/twinny", env, "manual", ["OPENAI_API_KEY"]).environment).toEqual({
      OPENAI_API_KEY: "secret",
      TWINNY_HOME: "/tmp/twinny",
      TWINNY_PROFILE: "host"
    });
    expect(buildServiceEnvironmentForChoice("/tmp/twinny", env, "none").environment).toEqual({
      TWINNY_HOME: "/tmp/twinny",
      TWINNY_PROFILE: "host"
    });
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

    expect(telemetry.capture).toHaveBeenCalledWith(
      "twinny_install_fail",
      expect.objectContaining({
        install_status: "failed",
        install_exit_reason: "non_tty",
        stdin_is_tty: false,
        stdout_is_tty: true,
        tty_mode: "non_tty"
      }),
      expect.objectContaining({ codexVersion: undefined })
    );
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

  it("detects Codex and checks login status through injectable commands", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "which") {
        return { stdout: "/usr/local/bin/codex\n", stderr: "", exitCode: 0 };
      }
      if (args[0] === "--version") {
        return { stdout: "codex-cli 0.133.0", stderr: "", exitCode: 0 };
      }
      if (args.join(" ") === "login status") {
        return { stdout: "Logged in using ChatGPT", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    });

    await expect(detectCodexBinary({}, { runCommand: runCommand as unknown as CodexCommandRunner })).resolves.toEqual({
      binary: "/usr/local/bin/codex",
      version: "0.133.0"
    });
    await expect(checkCodexLoginStatus("/usr/local/bin/codex", { runCommand: runCommand as unknown as CodexCommandRunner })).resolves.toEqual({
      loggedIn: true
    });
    expect(isCodexLoggedInOutput("Not logged in")).toBe(false);
  });

  it("installs Codex with npm global package", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await installCodexCli({ runCommand: runCommand as unknown as CodexCommandRunner });

    expect(runCommand).toHaveBeenCalledWith("npm", ["i", "-g", "@openai/codex"], expect.objectContaining({ stdio: "pipe" }));
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

  it("detects and installs lark-cli with non-TTY commands", async () => {
    const detectRunner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 1 }));
    const installRunner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(detectLarkCliBinary({ runCommand: detectRunner as unknown as LarkCliDetectRunner })).resolves.toBeUndefined();
    await installLarkCli({ runCommand: installRunner as unknown as LarkCliDetectRunner });

    expect(detectRunner).toHaveBeenCalledWith("which", ["lark-cli"], expect.objectContaining({ reject: false }));
    expect(installRunner).toHaveBeenCalledWith("npx", ["@larksuite/cli@latest", "install"], expect.objectContaining({ stdio: "pipe" }));
  });

  it("parses lark-cli profiles and persists an existing bot profile name", async () => {
    const home = await tempHome();
    const runCommand = vi.fn(async () => ({
      stdout: JSON.stringify([{ name: "cli_test", appId: "cli_test", brand: "feishu", active: true, tokenStatus: "valid" }]),
      stderr: "",
      exitCode: 0
    }));

    expect(parseLarkCliProfileList("[{\"name\":\"cli_test\"}]")).toEqual([{ name: "cli_test" }]);
    await expect(ensureLarkCliProfile({
      binary: "/usr/local/bin/lark-cli",
      appId: "cli_test",
      appSecret: "secret",
      brand: "feishu",
      home,
      runCommand: runCommand as unknown as LarkCliProfileRunner
    })).resolves.toEqual({ profileName: "cli_test", profilePersisted: true });

    expect(runCommand).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(home, "lark-cli-profile.json"), "utf8")).resolves.toContain("\"profileName\": \"cli_test\"");
  });

  it("adds and persists a missing lark-cli bot profile without switching active profile", async () => {
    const home = await tempHome();
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "[]", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    await ensureLarkCliProfile({
      binary: "/usr/local/bin/lark-cli",
      appId: "cli_test",
      appSecret: "secret",
      brand: "feishu",
      home,
      runCommand: runCommand as unknown as LarkCliProfileRunner
    });

    expect(runCommand).toHaveBeenLastCalledWith(
      "/usr/local/bin/lark-cli",
      ["profile", "add", "--name", "cli_test", "--app-id", "cli_test", "--app-secret-stdin", "--brand", "feishu"],
      expect.objectContaining({ input: "secret\n", reject: false })
    );
    expect(runCommand.mock.calls[1]![1]).not.toContain("--use");
    await expect(fs.readFile(path.join(home, "lark-cli-profile.json"), "utf8")).resolves.toContain("\"profileName\": \"cli_test\"");
  });

  it("runs the agent install flow with NDJSON auth events and no secret output", async () => {
    const home = await tempHome();
    const telemetry = createTelemetry();
    const output = createNdjsonOutput();
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "which" && args[0] === "codex") {
        return { stdout: "/usr/local/bin/codex\n", stderr: "", exitCode: 0 };
      }
      if (command === "/usr/local/bin/codex" && args[0] === "--version") {
        return { stdout: "codex-cli 0.133.0", stderr: "", exitCode: 0 };
      }
      if (command === "/usr/local/bin/codex" && args.join(" ") === "login status") {
        return { stdout: "Logged in using ChatGPT", stderr: "", exitCode: 0 };
      }
      if (command === "which" && args[0] === "lark-cli") {
        return { stdout: "/usr/local/bin/lark-cli\n", stderr: "", exitCode: 0 };
      }
      if (command === "/usr/local/bin/lark-cli" && args.join(" ") === "profile list") {
        return { stdout: "[]", stderr: "", exitCode: 0 };
      }
      if (command === "/usr/local/bin/lark-cli" && args[0] === "profile" && args[1] === "add") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });
    const installManagedServiceMock = vi.fn(async () => undefined);
    const uploadBundledAssetsMock = vi.fn(async () => undefined);
    const startManagedServiceMock = vi.fn(async () => undefined);
    const secretStore = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      has: vi.fn(async () => false)
    };

    await runInstallAgent({
      env: {
        TWINNY_HOME: home,
        FOO: "bar",
        OPENAI_API_KEY: "secret"
      },
      telemetry,
      stdout: output.writer,
      homeRandom: "a".repeat(32),
      runCommand: runCommand as unknown as CodexCommandRunner,
      secretStore: secretStore as NonNullable<Parameters<typeof runInstallAgent>[0]>["secretStore"],
      readCodexDefaults: async () => ({ model: "gpt-5.5", effort: "medium" }),
      resolveServiceEntrypoint: async () => "/tmp/twinny-bin",
      installManagedService: installManagedServiceMock as NonNullable<Parameters<typeof runInstallAgent>[0]>["installManagedService"],
      startManagedService: startManagedServiceMock as NonNullable<Parameters<typeof runInstallAgent>[0]>["startManagedService"],
      uploadBundledAssets: uploadBundledAssetsMock as NonNullable<Parameters<typeof runInstallAgent>[0]>["uploadBundledAssets"],
      validateBotCredentials: vi.fn(async () => undefined),
      auth: {
        requestAppRegistration: vi.fn(async () => ({
          deviceCode: "bot_device",
          userCode: "BOT-CODE",
          verificationUri: "https://open.feishu.cn/page/cli",
          verificationUriComplete: "https://open.feishu.cn/page/cli?user_code=BOT-CODE",
          expiresIn: 600,
          interval: 1
        })),
        pollAppRegistration: vi.fn(async () => ({
          appId: "cli_agent",
          appSecret: "app_secret",
          brand: "feishu" as const
        })),
        requestDeviceAuthorization: vi.fn(async () => ({
          deviceCode: "owner_device",
          userCode: "OWNER-CODE",
          verificationUri: "https://open.feishu.cn/oauth",
          verificationUriComplete: "https://open.feishu.cn/oauth?user_code=OWNER-CODE",
          expiresIn: 600,
          interval: 1
        })),
        pollDeviceToken: vi.fn(async () => ({
          accessToken: "owner_token",
          expiresIn: 7200,
          refreshExpiresIn: 7200
        })),
        getBrowserUserInfo: vi.fn(async () => ({ openId: "ou_owner", name: "Owner" }))
      }
    });

    const rawOutput = output.raw();
    expect(rawOutput).not.toContain("app_secret");
    expect(rawOutput).not.toContain("owner_token");
    const events = output.events();
    expect(events.filter((event) => event.type === "action_required")).toEqual([
      expect.objectContaining({
        type: "action_required",
        step: "bot_registration",
        verification_url: expect.stringContaining("from=cli"),
        user_code: "BOT-CODE"
      }),
      expect.objectContaining({
        type: "action_required",
        step: "owner_authorization",
        verification_url: "https://open.feishu.cn/oauth?user_code=OWNER-CODE",
        user_code: "OWNER-CODE"
      })
    ]);
    expect(events.at(-1)).toEqual({
      type: "completed",
      home,
      started: true,
      app_id: "cli_agent",
      guide_file_url: expect.stringMatching(/^file:\/\//),
      lark_cli_profile: "cli_agent"
    });
    await expect(fs.readFile(path.join(home, "install-guide", "index.html"), "utf8")).resolves.toContain(
      "https://open.larkoffice.com/app/cli_agent/auth"
    );
    expect(installManagedServiceMock).toHaveBeenCalledWith(expect.objectContaining({
      entrypoint: "/tmp/twinny-bin"
    }));
    expect(startManagedServiceMock).toHaveBeenCalledWith({ home });
    expect(runCommand).toHaveBeenCalledWith(
      "/usr/local/bin/lark-cli",
      ["profile", "add", "--name", "cli_agent", "--app-id", "cli_agent", "--app-secret-stdin", "--brand", "feishu"],
      expect.objectContaining({ input: "app_secret\n", reject: false })
    );
    await expect(fs.readFile(path.join(home, "lark-cli-profile.json"), "utf8")).resolves.toContain("\"profileName\": \"cli_agent\"");
    expect(telemetry.capture).toHaveBeenCalledWith(
      "twinny_install",
      expect.objectContaining({
        install_mode: "agent",
        install_status: "completed",
        launch_environment_choice: "default",
        lark_cli_profile_add_result: "succeeded"
      }),
      expect.objectContaining({ codexVersion: "0.133.0" })
    );
  });

  it("emits a failed agent event when Codex is missing and auto install is disabled", async () => {
    const home = await tempHome();
    const telemetry = createTelemetry();
    const output = createNdjsonOutput();
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 1 }));

    await expect(runInstallAgent({
      env: { TWINNY_HOME: home },
      telemetry,
      stdout: output.writer,
      installCodex: "never",
      runCommand: runCommand as unknown as CodexCommandRunner
    })).rejects.toThrow(/未检测到 Codex/);

    expect(output.events().at(-1)).toEqual(expect.objectContaining({
      type: "failed",
      step: "codex_detection",
      reason: "codex_missing",
      retryable: true
    }));
    expect(telemetry.capture).toHaveBeenCalledWith(
      "twinny_install_fail",
      expect.objectContaining({
        install_mode: "agent",
        install_status: "failed",
        install_exit_reason: "codex_missing",
        codex_detect_result: "missing",
        codex_install_choice: "declined"
      }),
      expect.any(Object)
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

function createNdjsonOutput(): {
  writer: NonNullable<Parameters<typeof runInstallAgent>[0]>["stdout"];
  raw: () => string;
  events: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  return {
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      }
    } as NonNullable<Parameters<typeof runInstallAgent>[0]>["stdout"],
    raw: () => chunks.join(""),
    events: () => chunks.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  };
}
