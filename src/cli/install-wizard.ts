import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { execa } from "execa";
import { parse } from "smol-toml";
import {
  bootstrapTwinnyHome,
  createRuntimePaths,
  createTwinnyConfig,
  expandHomePath,
  generateTwinnyHomeRandom,
  resolveBundledBannerPath,
  resolveBundledLogoPath,
  resolveTwinnyHome,
  createDefaultSecretStore,
  writeTwinnyAuthFile,
  writeLarkCliProfileConfig,
  type SecretStore
} from "../config/index.js";
import { provisionLarkAssetImageKeys } from "../app/lark-assets.js";
import { assertLaunchdGuiSessionAvailable } from "../launchd/install.js";
import { installManagedService, managedServiceDisplayName, startManagedService } from "../service/index.js";
import { createTwinnyTelemetryClient, type TelemetryClient, type TelemetryProperties } from "../telemetry/index.js";
import {
  buildLarkVerificationUrl,
  getLarkBrowserUserInfo,
  LarkFileDownloader,
  LarkOpenApiClient,
  LarkUserDirectory,
  pollLarkAppRegistration,
  pollLarkDeviceToken,
  requestLarkAppRegistration,
  requestLarkDeviceAuthorization,
  resolveLarkEndpoints,
  TenantAccessTokenManager
} from "../lark/index.js";
import { TWINNY_VERSION } from "../version.js";
import { openInstallGuidePageBestEffort, writeInstallGuidePage } from "./install-guide.js";
import type { LarkBrand, ServiceConfig, TelemetryConfig, TwinnyConfig } from "../types.js";

const minimumCodexVersion = "0.130.0";
export const installWizardIntro = "🐰 Twinny install";
export const installWizardLarkBrand: LarkBrand = "feishu";

const sensitiveEnvPattern = /(?:SECRET|TOKEN|PASSWORD|PASS|PWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|COOKIE|SESSION|CREDENTIAL|AUTH)/i;
const terminalEnvKeys = new Set([
  "_",
  "COLORTERM",
  "CODEX_CI",
  "CODEX_MANAGED_BY_NPM",
  "CODEX_MANAGED_PACKAGE_ROOT",
  "CODEX_THREAD_ID",
  "DBUS_SESSION_BUS_ADDRESS",
  "LS_COLORS",
  "LSCOLORS",
  "MOTD_SHOWN",
  "OLDPWD",
  "PWD",
  "SHLVL",
  "SSH_AUTH_SOCK",
  "SSH_CLIENT",
  "SSH_CONNECTION",
  "SSH_TTY",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "TMPDIR",
  "TTY"
]);

type BotChoice = "auto" | "manual";
type OwnerChoice = "browser" | "manual";
export type ServiceEnvironmentChoice = "default" | "manual" | "none";
type InstallMode = "interactive" | "agent";
export type InstallAgentAutoPreference = "auto" | "never";
type CodexDetectResult = "not_started" | "found" | "missing" | "version_failed" | "error";
type CodexInstallChoice = "not_prompted" | "accepted" | "declined";
type CodexInstallResult = "not_attempted" | "succeeded" | "failed";
type CodexLoginResult = "not_checked" | "logged_in" | "not_logged_in" | "error";
type LarkCliDetectResult = "not_started" | "found" | "missing" | "error";
type LarkCliInstallChoice = "not_prompted" | "accepted" | "declined";
type LarkCliInstallResult = "not_attempted" | "succeeded" | "failed";
type LarkCliProfileListResult = "not_started" | "profile_found" | "profile_missing" | "skipped" | "error";
type LarkCliProfileAddResult = "not_attempted" | "succeeded" | "failed";
type AssetUploadResult = "not_attempted" | "succeeded" | "failed";
type InstallExitReason =
  | "non_tty"
  | "codex_missing"
  | "codex_install_declined"
  | "codex_login_required"
  | "launchd_gui_unavailable"
  | "home_not_empty"
  | "install_cancelled"
  | "bot_registration_failed"
  | "owner_authorization_failed"
  | "error";

type CommandRunner = typeof execa;
type InstallAgentOutput = Pick<NodeJS.WriteStream, "write">;
type UploadBundledAssetsFn = typeof uploadBundledAssets;
type InstallManagedServiceFn = typeof installManagedService;
type StartManagedServiceFn = typeof startManagedService;
type AssertGuiLaunchAgentAvailableFn = typeof assertLaunchdGuiSessionAvailable;

type InstallAgentStep =
  | "init"
  | "codex_detection"
  | "codex_install"
  | "codex_login"
  | "bot_registration"
  | "bot_credentials_validation"
  | "owner_authorization"
  | "environment"
  | "codex_defaults"
  | "config"
  | "asset_upload"
  | "lark_cli"
  | "install_guide"
  | "start"
  | "complete";

export type InstallAgentEvent =
  | {
      type: "progress";
      step: InstallAgentStep;
      status: "started" | "completed" | "skipped";
      detail?: Record<string, unknown>;
    }
  | {
      type: "action_required";
      step: "bot_registration" | "owner_authorization";
      verification_url: string;
      user_code: string;
      expires_in: number;
    }
  | {
      type: "completed";
      home: string;
      started: boolean;
      app_id: string;
      guide_file_url: string;
      lark_cli_profile?: string;
    }
  | {
      type: "failed";
      step: InstallAgentStep;
      reason: InstallExitReason;
      retryable: boolean;
      message: string;
    };

export interface RunInstallAgentOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  disableKeychain?: boolean;
  systemDaemon?: boolean;
  assertGuiLaunchAgentAvailable?: AssertGuiLaunchAgentAvailableFn;
  telemetry?: TelemetryClient;
  stdout?: InstallAgentOutput;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  envMode?: ServiceEnvironmentChoice;
  envKeys?: string[];
  installCodex?: InstallAgentAutoPreference;
  installLarkCli?: InstallAgentAutoPreference;
  start?: boolean;
  runCommand?: CommandRunner;
  secretStore?: SecretStore;
  homeRandom?: string;
  readCodexDefaults?: () => Promise<CodexDefaults>;
  resolveServiceEntrypoint?: (home: string) => Promise<string>;
  installManagedService?: InstallManagedServiceFn;
  startManagedService?: StartManagedServiceFn;
  uploadBundledAssets?: UploadBundledAssetsFn;
  validateBotCredentials?: (credentials: BotCredentials) => Promise<void>;
  auth?: {
    requestAppRegistration?: typeof requestLarkAppRegistration;
    pollAppRegistration?: typeof pollLarkAppRegistration;
    requestDeviceAuthorization?: typeof requestLarkDeviceAuthorization;
    pollDeviceToken?: typeof pollLarkDeviceToken;
    getBrowserUserInfo?: typeof getLarkBrowserUserInfo;
  };
}

interface BotCredentials {
  appId: string;
  appSecret: string;
  brand: LarkBrand;
}

interface BotSetupResult {
  credentials: BotCredentials;
  method: BotChoice;
}

interface OwnerIdentity {
  openId: string;
  displayName: string;
}

interface OwnerSetupResult {
  identity: OwnerIdentity;
  method: OwnerChoice;
}

interface CodexDetection {
  binary: string;
  version: string;
}

interface CodexDefaults {
  model: string;
  effort: string;
}

export interface LarkCliProfileSetupResult {
  profileName?: string;
  profilePersisted: boolean;
  profileStatus?: "existing" | "created";
}

export interface ServiceEnvironmentStats {
  importedEnvKeyCount: number;
  candidateEnvKeyCount: number;
  defaultIncludedEnvKeyCount: number;
}

interface ServiceEnvironmentSelection {
  environment: Record<string, string>;
  stats: ServiceEnvironmentStats;
}

interface FinalizeInstallResult {
  homeCreated: boolean;
  wroteHomeRandom: boolean;
  wroteConfig: boolean;
  wroteAuth: boolean;
  serviceInstalled: boolean;
  assetUploadAttempted: boolean;
  larkCliProfilePersisted: boolean;
}

interface InstallTerminalSnapshot {
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  ttyMode: "tty" | "non_tty";
}

interface InstallTelemetryState {
  codexDetectResult: CodexDetectResult;
  codexInstallChoice: CodexInstallChoice;
  codexInstallResult: CodexInstallResult;
  codexLoginResult: CodexLoginResult;
  serviceEnvironmentChoice: ServiceEnvironmentChoice | "not_prompted";
  assetUploadResult: AssetUploadResult;
  larkCliDetectResult: LarkCliDetectResult;
  larkCliInstallChoice: LarkCliInstallChoice;
  larkCliInstallResult: LarkCliInstallResult;
  larkCliProfileListResult: LarkCliProfileListResult;
  larkCliProfileAddResult: LarkCliProfileAddResult;
  larkCliProfileName?: string;
}

export interface RunInstallWizardOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  disableKeychain?: boolean;
  systemDaemon?: boolean;
  assertGuiLaunchAgentAvailable?: AssertGuiLaunchAgentAvailableFn;
  telemetry?: TelemetryClient;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

export async function runInstallWizard(options: RunInstallWizardOptions = {}): Promise<void> {
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const terminal = installTerminalSnapshot(options);
  const home = resolveInstallHome(env);
  const homeRandom = generateTwinnyHomeRandom();
  const service = installServiceConfig({ platform, systemDaemon: options.systemDaemon, env });
  const installTelemetry = createInitialInstallTelemetryState();
  const finalizeResult = createInitialFinalizeInstallResult();
  let telemetry = options.telemetry;
  let config: TwinnyConfig | undefined;
  let codex: CodexDetection | undefined;
  let botSetup: BotSetupResult | undefined;
  let ownerSetup: OwnerSetupResult | undefined;
  let serviceEnvironment: ServiceEnvironmentSelection | undefined;
  let codexDefaults: CodexDefaults | undefined;
  let startedAfterInstall = false;

  try {
    telemetry ??= createTwinnyTelemetryClient(createInstallTelemetryConfig(home, homeRandom, env), {
      codexVersion: () => codex?.version
    });
    if (!terminal.stdinIsTty || !terminal.stdoutIsTty) {
      throw new InstallExitError(
        "non_tty",
        "Twinny install wizard requires an interactive terminal. Run `twinny install` from a terminal."
      );
    }
    await assertInstallGuiLaunchAgentAvailable({
      platform,
      systemDaemon: options.systemDaemon,
      assertGuiLaunchAgentAvailable: options.assertGuiLaunchAgentAvailable
    });

    p.intro(installWizardIntro);
    await assertInstallHomeIsEmpty(home);
    codex = await promptCodexSetup(env, installTelemetry);
    p.log.success(`Codex ${codex.version} (${codex.binary})`);
    await ensureCodexLogin(codex.binary, installTelemetry);

    botSetup = await promptBotCredentials();
    const bot = botSetup.credentials;
    ownerSetup = await promptOwnerIdentity(bot);
    const owner = ownerSetup.identity;
    serviceEnvironment = await promptServiceEnvironment(home, env, installTelemetry, installManagedServiceDisplayName(platform, service));
    codexDefaults = await readCodexDefaults();

    config = createTwinnyConfig({
      home,
      homeRandom,
      codex: { binary: codex.binary },
      auth: {
        larkAppId: bot.appId,
        larkBrand: bot.brand,
        ownerOpenId: owner.openId,
        displayName: owner.displayName
      },
      service,
      telemetry: installTelemetryConfigFromEnv(env),
      profiles: {
        host: {
          defaultModel: codexDefaults.model,
          defaultEffort: codexDefaults.effort
        },
        guest: {}
      }
    });

    await finalizeInstall({
      config,
      appSecret: bot.appSecret,
      environment: serviceEnvironment.environment,
      result: finalizeResult,
      telemetry: installTelemetry,
      platform,
      disableKeychain: options.disableKeychain
    });

    const shouldStart = await cancelable(
      p.confirm({
        message: "安装完成。现在启动 Twinny？",
        initialValue: true
      })
    );
    startedAfterInstall = shouldStart;
    try {
      if (shouldStart) {
        const s = p.spinner();
        s.start("启动 Twinny");
        try {
          await startManagedService({ home });
          s.stop("Twinny 已启动");
          p.log.success("🐰 安装完成，现在在飞书里愉快使用 CodeX 吧 🎉");
        } catch (error) {
          s.error("Twinny 启动失败");
          throw error;
        }
      } else {
        p.log.info(`稍后可执行：TWINNY_HOME=${shellQuote(home)} twinny start`);
      }
    } finally {
      await openInstallGuidePageBestEffort(bot.appId);
    }
    telemetry.capture(
      "twinny_install",
      installTelemetryProperties({
        install_mode: "interactive",
        install_status: "completed",
        install_duration_ms: Date.now() - startedAt,
        terminal,
        serviceEnvironment,
        finalizeResult,
        installTelemetry,
        started_after_install: startedAfterInstall,
        codex_binary_id: telemetry.hashId("codex_binary", codex.binary),
        lark_cli_profile_name_id: telemetry.hashId("lark_cli_profile", installTelemetry.larkCliProfileName),
        default_model: codexDefaults.model,
        default_effort: codexDefaults.effort,
        bot_setup_method: botSetup.method,
        owner_setup_method: ownerSetup.method
      }),
      {
        insertId: `twinny_install:${telemetry.hashId("install_event", homeRandom)}`,
        codexVersion: codex.version
      }
    );
    p.outro("Twinny 安装完成");
  } catch (error) {
    telemetry?.capture(
      "twinny_install_fail",
      installTelemetryProperties({
        install_mode: "interactive",
        install_status: "failed",
        install_duration_ms: Date.now() - startedAt,
        terminal,
        serviceEnvironment,
        finalizeResult,
        installTelemetry,
        started_after_install: startedAfterInstall,
        codex_binary_id: codex && telemetry ? telemetry.hashId("codex_binary", codex.binary) : null,
        lark_cli_profile_name_id: telemetry?.hashId("lark_cli_profile", installTelemetry.larkCliProfileName) ?? null,
        default_model: codexDefaults?.model ?? null,
        default_effort: codexDefaults?.effort ?? null,
        bot_setup_method: botSetup?.method ?? null,
        owner_setup_method: ownerSetup?.method ?? null,
        install_exit_reason: installExitReason(error)
      }),
      {
        insertId: `twinny_install_fail:${telemetry?.hashId("install_event", homeRandom) ?? "unknown"}`,
        codexVersion: codex?.version
      }
    );
    telemetry?.captureError(error, {
      errorType: "install",
      errorSite: "cli.runInstallWizard",
      operation: "install",
      fatal: true,
      codexVersion: codex?.version,
      properties: {
        ...installTelemetryProperties({
          install_mode: "interactive",
          install_status: "failed",
          install_duration_ms: Date.now() - startedAt,
          terminal,
          serviceEnvironment,
          finalizeResult,
          installTelemetry,
          started_after_install: startedAfterInstall,
          codex_binary_id: codex && telemetry ? telemetry.hashId("codex_binary", codex.binary) : null,
          lark_cli_profile_name_id: telemetry?.hashId("lark_cli_profile", installTelemetry.larkCliProfileName) ?? null,
          default_model: codexDefaults?.model ?? null,
          default_effort: codexDefaults?.effort ?? null,
          bot_setup_method: botSetup?.method ?? null,
          owner_setup_method: ownerSetup?.method ?? null,
          install_exit_reason: installExitReason(error)
        })
      }
    });
    throw error;
  } finally {
    await telemetry?.shutdown?.();
  }
}

export async function runInstallAgent(options: RunInstallAgentOptions = {}): Promise<void> {
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const terminal = installTerminalSnapshot(options);
  const home = resolveInstallHome(env);
  const homeRandom = options.homeRandom ?? generateTwinnyHomeRandom();
  const service = installServiceConfig({ platform, systemDaemon: options.systemDaemon, env });
  const installTelemetry = createInitialInstallTelemetryState();
  const finalizeResult = createInitialFinalizeInstallResult();
  const events = new InstallAgentEventWriter(options.stdout ?? process.stdout);
  const installCodex = options.installCodex ?? "auto";
  const installLarkCli = options.installLarkCli ?? "auto";
  const envMode = options.envMode ?? "default";
  const envKeys = options.envKeys ?? [];
  let telemetry = options.telemetry;
  let config: TwinnyConfig | undefined;
  let codex: CodexDetection | undefined;
  let botSetup: BotSetupResult | undefined;
  let ownerSetup: OwnerSetupResult | undefined;
  let serviceEnvironment: ServiceEnvironmentSelection | undefined;
  let codexDefaults: CodexDefaults | undefined;
  let guideFileUrl = "";
  let startedAfterInstall = false;
  let currentStep: InstallAgentStep = "init";

  const progress = (
    step: InstallAgentStep,
    status: "started" | "completed" | "skipped",
    detail?: Record<string, unknown>
  ) => {
    currentStep = step;
    events.emit({ type: "progress", step, status, ...(detail ? { detail } : {}) });
  };

  try {
    telemetry ??= createTwinnyTelemetryClient(createInstallTelemetryConfig(home, homeRandom, env), {
      codexVersion: () => codex?.version
    });

    progress("init", "started", { home });
    await assertInstallGuiLaunchAgentAvailable({
      platform,
      systemDaemon: options.systemDaemon,
      assertGuiLaunchAgentAvailable: options.assertGuiLaunchAgentAvailable
    });
    await assertInstallHomeIsEmpty(home);
    progress("init", "completed");

    progress("codex_detection", "started");
    codex = await detectOrInstallCodexForAgent(env, installTelemetry, {
      installCodex,
      runCommand: options.runCommand,
      progress
    });
    progress("codex_detection", "completed", { version: codex.version });

    progress("codex_login", "started");
    await ensureCodexLogin(codex.binary, installTelemetry, {
      runCommand: options.runCommand,
      interactive: false
    });
    progress("codex_login", "completed");

    progress("bot_registration", "started");
    const bot = await createBotWithBrowserForAgent(events, options.auth);
    botSetup = { credentials: bot, method: "auto" };
    progress("bot_registration", "completed", { app_id: bot.appId, brand: bot.brand });

    progress("bot_credentials_validation", "started");
    await (options.validateBotCredentials ?? ((credentials) => validateBotCredentials(credentials, { interactive: false })))(bot);
    progress("bot_credentials_validation", "completed");

    progress("owner_authorization", "started");
    const owner = await authorizeOwnerInBrowserForAgent(bot, events, options.auth);
    ownerSetup = { identity: owner, method: "browser" };
    progress("owner_authorization", "completed");

    progress("environment", "started", { mode: envMode });
    installTelemetry.serviceEnvironmentChoice = envMode;
    serviceEnvironment = buildServiceEnvironmentForChoice(home, env, envMode, envMode === "manual" ? envKeys : []);
    progress("environment", "completed", {
      mode: envMode,
      imported_env_key_count: serviceEnvironment.stats.importedEnvKeyCount
    });

    progress("codex_defaults", "started");
    codexDefaults = await (options.readCodexDefaults ?? readCodexDefaults)();
    progress("codex_defaults", "completed", {
      default_model: codexDefaults.model,
      default_effort: codexDefaults.effort
    });

    config = createTwinnyConfig({
      home,
      homeRandom,
      codex: { binary: codex.binary },
      auth: {
        larkAppId: bot.appId,
        larkBrand: bot.brand,
        ownerOpenId: owner.openId,
        displayName: owner.displayName
      },
      service,
      telemetry: installTelemetryConfigFromEnv(env),
      profiles: {
        host: {
          defaultModel: codexDefaults.model,
          defaultEffort: codexDefaults.effort
        },
        guest: {}
      }
    });

    await finalizeInstall({
      config,
      appSecret: bot.appSecret,
      environment: serviceEnvironment.environment,
      result: finalizeResult,
      telemetry: installTelemetry,
      secretStore: options.secretStore,
      interactive: false,
      larkCliInstallPreference: installLarkCli,
      runCommand: options.runCommand,
      resolveServiceEntrypoint: options.resolveServiceEntrypoint,
      installManagedService: options.installManagedService,
      uploadBundledAssets: options.uploadBundledAssets,
      onProgress: progress,
      platform,
      disableKeychain: options.disableKeychain
    });

    progress("install_guide", "started");
    const guidePage = await writeInstallGuidePage(bot.appId, { outputDir: path.join(home, "install-guide") });
    guideFileUrl = guidePage.fileUrl;
    progress("install_guide", "completed", { file_url: guideFileUrl });

    startedAfterInstall = options.start ?? true;
    if (startedAfterInstall) {
      progress("start", "started");
      await (options.startManagedService ?? startManagedService)({ home });
      progress("start", "completed");
    } else {
      progress("start", "skipped");
    }

    telemetry.capture(
      "twinny_install",
      installTelemetryProperties({
        install_mode: "agent",
        install_status: "completed",
        install_duration_ms: Date.now() - startedAt,
        terminal,
        serviceEnvironment,
        finalizeResult,
        installTelemetry,
        started_after_install: startedAfterInstall,
        codex_binary_id: telemetry.hashId("codex_binary", codex.binary),
        lark_cli_profile_name_id: telemetry.hashId("lark_cli_profile", installTelemetry.larkCliProfileName),
        default_model: codexDefaults.model,
        default_effort: codexDefaults.effort,
        bot_setup_method: botSetup.method,
        owner_setup_method: ownerSetup.method
      }),
      {
        insertId: `twinny_install:${telemetry.hashId("install_event", homeRandom)}`,
        codexVersion: codex.version
      }
    );

    currentStep = "complete";
    events.emit({
      type: "completed",
      home,
      started: startedAfterInstall,
      app_id: bot.appId,
      guide_file_url: guideFileUrl,
      ...(installTelemetry.larkCliProfileName ? { lark_cli_profile: installTelemetry.larkCliProfileName } : {})
    });
  } catch (error) {
    const reason = installExitReason(error, currentStep);
    telemetry?.capture(
      "twinny_install_fail",
      installTelemetryProperties({
        install_mode: "agent",
        install_status: "failed",
        install_duration_ms: Date.now() - startedAt,
        terminal,
        serviceEnvironment,
        finalizeResult,
        installTelemetry,
        started_after_install: startedAfterInstall,
        codex_binary_id: codex && telemetry ? telemetry.hashId("codex_binary", codex.binary) : null,
        lark_cli_profile_name_id: telemetry?.hashId("lark_cli_profile", installTelemetry.larkCliProfileName) ?? null,
        default_model: codexDefaults?.model ?? null,
        default_effort: codexDefaults?.effort ?? null,
        bot_setup_method: botSetup?.method ?? null,
        owner_setup_method: ownerSetup?.method ?? null,
        install_exit_reason: reason
      }),
      {
        insertId: `twinny_install_fail:${telemetry?.hashId("install_event", homeRandom) ?? "unknown"}`,
        codexVersion: codex?.version
      }
    );
    telemetry?.captureError(error, {
      errorType: "install",
      errorSite: "cli.runInstallAgent",
      operation: "install",
      fatal: true,
      codexVersion: codex?.version,
      properties: {
        ...installTelemetryProperties({
          install_mode: "agent",
          install_status: "failed",
          install_duration_ms: Date.now() - startedAt,
          terminal,
          serviceEnvironment,
          finalizeResult,
          installTelemetry,
          started_after_install: startedAfterInstall,
          codex_binary_id: codex && telemetry ? telemetry.hashId("codex_binary", codex.binary) : null,
          lark_cli_profile_name_id: telemetry?.hashId("lark_cli_profile", installTelemetry.larkCliProfileName) ?? null,
          default_model: codexDefaults?.model ?? null,
          default_effort: codexDefaults?.effort ?? null,
          bot_setup_method: botSetup?.method ?? null,
          owner_setup_method: ownerSetup?.method ?? null,
          install_exit_reason: reason
        })
      }
    });
    events.emit({
      type: "failed",
      step: currentStep,
      reason,
      retryable: retryableInstallFailure(reason),
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    await telemetry?.shutdown?.();
  }
}

class InstallExitError extends Error {
  constructor(readonly reason: InstallExitReason, message: string) {
    super(message);
    this.name = "InstallExitError";
  }
}

class CodexNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexNotFoundError";
  }
}

class InstallAgentEventWriter {
  constructor(private readonly output: InstallAgentOutput) {}

  emit(event: InstallAgentEvent): void {
    this.output.write(`${JSON.stringify(event)}\n`);
  }
}

function installServiceConfig(input: {
  platform: NodeJS.Platform;
  systemDaemon?: boolean;
  env: NodeJS.ProcessEnv;
}): { launchd: { mode: "daemon"; userName: string } } | undefined {
  if (input.platform !== "darwin" || !input.systemDaemon) {
    return undefined;
  }
  return {
    launchd: {
      mode: "daemon",
      userName: currentLaunchDaemonUserName(input.env)
    }
  };
}

function installManagedServiceDisplayName(platform: NodeJS.Platform, service?: Partial<ServiceConfig>): string {
  if (platform === "darwin" && service?.launchd?.mode === "daemon") {
    return "LaunchDaemon";
  }
  return managedServiceDisplayName(platform);
}

async function assertInstallGuiLaunchAgentAvailable(input: {
  platform: NodeJS.Platform;
  systemDaemon?: boolean;
  assertGuiLaunchAgentAvailable?: AssertGuiLaunchAgentAvailableFn;
}): Promise<void> {
  if (input.platform !== "darwin" || input.systemDaemon) {
    return;
  }
  try {
    await (input.assertGuiLaunchAgentAvailable ?? assertLaunchdGuiSessionAvailable)();
  } catch (error) {
    throw new InstallExitError("launchd_gui_unavailable", error instanceof Error ? error.message : String(error));
  }
}

function currentLaunchDaemonUserName(env: NodeJS.ProcessEnv): string {
  const sudoUser = env.SUDO_USER?.trim();
  if (sudoUser && sudoUser !== "root") {
    return sudoUser;
  }
  return os.userInfo().username;
}

function createInstallTelemetryConfig(home: string, homeRandom: string, env: NodeJS.ProcessEnv): TwinnyConfig {
  return createTwinnyConfig({
    home,
    homeRandom,
    codex: { binary: "codex" },
    auth: {
      larkAppId: "",
      larkBrand: installWizardLarkBrand,
      ownerOpenId: "",
      displayName: ""
    },
    telemetry: installTelemetryConfigFromEnv(env),
    profiles: {
      host: {},
      guest: {}
    }
  });
}

function createInitialInstallTelemetryState(): InstallTelemetryState {
  return {
    codexDetectResult: "not_started",
    codexInstallChoice: "not_prompted",
    codexInstallResult: "not_attempted",
    codexLoginResult: "not_checked",
    serviceEnvironmentChoice: "not_prompted",
    assetUploadResult: "not_attempted",
    larkCliDetectResult: "not_started",
    larkCliInstallChoice: "not_prompted",
    larkCliInstallResult: "not_attempted",
    larkCliProfileListResult: "not_started",
    larkCliProfileAddResult: "not_attempted"
  };
}

function createInitialFinalizeInstallResult(): FinalizeInstallResult {
  return {
    homeCreated: false,
    wroteHomeRandom: false,
    wroteConfig: false,
    wroteAuth: false,
    serviceInstalled: false,
    assetUploadAttempted: false,
    larkCliProfilePersisted: false
  };
}

function installExitReason(error: unknown, step?: InstallAgentStep): InstallExitReason {
  if (error instanceof InstallExitError) {
    return error.reason;
  }
  if (error instanceof Error && /TWINNY_HOME is not empty/.test(error.message)) {
    return "home_not_empty";
  }
  if (step === "bot_registration") {
    return "bot_registration_failed";
  }
  if (step === "owner_authorization") {
    return "owner_authorization_failed";
  }
  return "error";
}

function retryableInstallFailure(reason: InstallExitReason): boolean {
  return [
    "codex_missing",
    "codex_install_declined",
    "codex_login_required",
    "launchd_gui_unavailable",
    "bot_registration_failed",
    "owner_authorization_failed",
    "error"
  ].includes(reason);
}

function installTelemetryProperties(input: {
  install_mode: InstallMode;
  install_status: "completed" | "failed";
  install_duration_ms: number;
  terminal: InstallTerminalSnapshot;
  serviceEnvironment: ServiceEnvironmentSelection | undefined;
  finalizeResult: FinalizeInstallResult;
  installTelemetry: InstallTelemetryState;
  started_after_install: boolean;
  codex_binary_id: string | null;
  lark_cli_profile_name_id: string | null;
  default_model: string | null;
  default_effort: string | null;
  bot_setup_method: BotChoice | null;
  owner_setup_method: OwnerChoice | null;
  install_exit_reason?: InstallExitReason;
}): TelemetryProperties {
  return {
    install_mode: input.install_mode,
    install_status: input.install_status,
    install_exit_reason: input.install_exit_reason ?? null,
    install_duration_ms: input.install_duration_ms,
    stdin_is_tty: input.terminal.stdinIsTty,
    stdout_is_tty: input.terminal.stdoutIsTty,
    tty_mode: input.terminal.ttyMode,
    imported_env_key_count: input.serviceEnvironment?.stats.importedEnvKeyCount ?? null,
    candidate_env_key_count: input.serviceEnvironment?.stats.candidateEnvKeyCount ?? null,
    default_included_env_key_count: input.serviceEnvironment?.stats.defaultIncludedEnvKeyCount ?? null,
    launch_environment_choice: input.installTelemetry.serviceEnvironmentChoice,
    started_after_install: input.started_after_install,
    home_created: input.finalizeResult.homeCreated,
    wrote_home_random: input.finalizeResult.wroteHomeRandom,
    wrote_config: input.finalizeResult.wroteConfig,
    wrote_auth: input.finalizeResult.wroteAuth,
    service_installed: input.finalizeResult.serviceInstalled,
    launch_agent_installed: input.finalizeResult.serviceInstalled,
    service_manager: safeManagedServiceDisplayName(),
    asset_upload_attempted: input.finalizeResult.assetUploadAttempted,
    asset_upload_result: input.installTelemetry.assetUploadResult,
    codex_detect_result: input.installTelemetry.codexDetectResult,
    codex_install_choice: input.installTelemetry.codexInstallChoice,
    codex_install_result: input.installTelemetry.codexInstallResult,
    codex_login_result: input.installTelemetry.codexLoginResult,
    codex_binary_id: input.codex_binary_id,
    lark_cli_detect_result: input.installTelemetry.larkCliDetectResult,
    lark_cli_install_choice: input.installTelemetry.larkCliInstallChoice,
    lark_cli_install_result: input.installTelemetry.larkCliInstallResult,
    lark_cli_profile_list_result: input.installTelemetry.larkCliProfileListResult,
    lark_cli_profile_add_result: input.installTelemetry.larkCliProfileAddResult,
    lark_cli_profile_persisted: input.finalizeResult.larkCliProfilePersisted,
    lark_cli_profile_name_id: input.lark_cli_profile_name_id,
    default_model: input.default_model,
    default_effort: input.default_effort,
    bot_setup_method: input.bot_setup_method,
    owner_setup_method: input.owner_setup_method
  };
}

export function resolveInstallHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolveTwinnyHome({ env });
}

function installTerminalSnapshot(options: RunInstallWizardOptions): InstallTerminalSnapshot {
  const stdinIsTty = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTty = options.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  return {
    stdinIsTty,
    stdoutIsTty,
    ttyMode: stdinIsTty && stdoutIsTty ? "tty" : "non_tty"
  };
}

function installTelemetryConfigFromEnv(env: NodeJS.ProcessEnv): Partial<TelemetryConfig> | undefined {
  const posthogProjectToken =
    optionalEnv(env.TWINNY_TELEMETRY_POSTHOG_PROJECT_TOKEN) ??
    optionalEnv(env.TWINNY_POSTHOG_PROJECT_TOKEN);
  const posthogHost = optionalEnv(env.TWINNY_TELEMETRY_POSTHOG_HOST) ?? optionalEnv(env.TWINNY_POSTHOG_HOST);
  const enabled = booleanEnv(env.TWINNY_TELEMETRY_ENABLED);
  if (posthogProjectToken === undefined && posthogHost === undefined && enabled === undefined) {
    return undefined;
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(posthogProjectToken ? { posthogProjectToken } : {}),
    ...(posthogHost ? { posthogHost } : {})
  };
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function booleanEnv(value: string | undefined): boolean | undefined {
  const normalized = optionalEnv(value)?.toLowerCase();
  if (normalized === undefined) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function safeManagedServiceDisplayName(): string {
  try {
    return managedServiceDisplayName();
  } catch {
    return "unsupported";
  }
}

export async function assertInstallHomeIsEmpty(home: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(home);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(`TWINNY_HOME must be a directory: ${home}`);
  }
  const entries = await fs.readdir(home);
  if (entries.length > 0) {
    throw new Error(`TWINNY_HOME is not empty: ${home}. Choose an empty directory and retry with TWINNY_HOME=/path twinny install.`);
  }
}

interface CodexCommandOptions {
  runCommand?: CommandRunner;
}

export async function detectCodexBinary(
  env: NodeJS.ProcessEnv = process.env,
  options: CodexCommandOptions = {}
): Promise<CodexDetection> {
  const runCommand = options.runCommand ?? execa;
  const binary = env.CODEX_BINARY?.trim()
    ? path.resolve(expandHomePath(env.CODEX_BINARY.trim()))
    : (await runCommand("which", ["codex"], { reject: false })).stdout.trim().split("\n")[0] ?? "";
  if (!binary) {
    throw new CodexNotFoundError(`codex was not found in PATH. Install Codex ${minimumCodexVersion}+ or set CODEX_BINARY.`);
  }
  const result = await runCommand(binary, ["--version"], { reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`failed to run ${binary} --version: ${result.stderr || `exit ${result.exitCode}`}`);
  }
  const version = parseCodexVersion(result.stdout.trim());
  if (!version || compareSemver(version, minimumCodexVersion) < 0) {
    throw new Error(`Codex ${minimumCodexVersion}+ is required. Found: ${result.stdout.trim() || "unknown"}. Install a newer Codex or set CODEX_BINARY.`);
  }
  return { binary, version };
}

async function promptCodexSetup(env: NodeJS.ProcessEnv, telemetry: InstallTelemetryState): Promise<CodexDetection> {
  try {
    const codex = await detectCodexBinary(env);
    telemetry.codexDetectResult = "found";
    return codex;
  } catch (error) {
    if (!(error instanceof CodexNotFoundError) || env.CODEX_BINARY?.trim()) {
      telemetry.codexDetectResult = error instanceof Error && /Codex .* is required/.test(error.message) ? "version_failed" : "error";
      throw error;
    }
    telemetry.codexDetectResult = "missing";
  }

  const shouldInstall = await cancelable(
    p.confirm({
      message: "未检测到 Codex。是否自动安装 @openai/codex？",
      initialValue: true
    })
  );
  if (!shouldInstall) {
    telemetry.codexInstallChoice = "declined";
    throw new InstallExitError(
      "codex_install_declined",
      "未检测到 Codex。请先安装 Codex，或通过 CODEX_BINARY 环境变量手动指定 Codex 路径。"
    );
  }
  telemetry.codexInstallChoice = "accepted";
  await installCodexCli({ telemetry });
  const codex = await detectCodexBinary(env);
  telemetry.codexDetectResult = "found";
  return codex;
}

async function detectOrInstallCodexForAgent(
  env: NodeJS.ProcessEnv,
  telemetry: InstallTelemetryState,
  options: {
    installCodex: InstallAgentAutoPreference;
    runCommand?: CommandRunner;
    progress: (
      step: InstallAgentStep,
      status: "started" | "completed" | "skipped",
      detail?: Record<string, unknown>
    ) => void;
  }
): Promise<CodexDetection> {
  try {
    const codex = await detectCodexBinary(env, { runCommand: options.runCommand });
    telemetry.codexDetectResult = "found";
    return codex;
  } catch (error) {
    if (!(error instanceof CodexNotFoundError) || env.CODEX_BINARY?.trim()) {
      telemetry.codexDetectResult = error instanceof Error && /Codex .* is required/.test(error.message) ? "version_failed" : "error";
      throw error;
    }
    telemetry.codexDetectResult = "missing";
  }

  if (options.installCodex === "never") {
    telemetry.codexInstallChoice = "declined";
    throw new InstallExitError(
      "codex_missing",
      "未检测到 Codex。请先安装 Codex，或通过 CODEX_BINARY 环境变量手动指定 Codex 路径。"
    );
  }

  telemetry.codexInstallChoice = "accepted";
  options.progress("codex_install", "started");
  await installCodexCli({ telemetry, runCommand: options.runCommand, interactive: false });
  options.progress("codex_install", "completed");
  const codex = await detectCodexBinary(env, { runCommand: options.runCommand });
  telemetry.codexDetectResult = "found";
  return codex;
}

export async function installCodexCli(options: {
  runCommand?: CommandRunner;
  telemetry?: InstallTelemetryState;
  interactive?: boolean;
} = {}): Promise<void> {
  const runCommand = options.runCommand ?? execa;
  const s = options.interactive === false ? undefined : p.spinner();
  s?.start("安装 Codex CLI");
  try {
    await runCommand("npm", ["i", "-g", "@openai/codex"], { stdio: "pipe" });
    options.telemetry && (options.telemetry.codexInstallResult = "succeeded");
    s?.stop("Codex CLI 已安装");
  } catch (error) {
    options.telemetry && (options.telemetry.codexInstallResult = "failed");
    s?.error("Codex CLI 安装失败");
    const output = childProcessErrorOutput(error);
    throw new Error(output ? `failed to install @openai/codex:\n${output}` : "failed to install @openai/codex", { cause: error });
  }
}

export async function checkCodexLoginStatus(
  binary: string,
  options: CodexCommandOptions = {}
): Promise<{ loggedIn: boolean }> {
  const result = await (options.runCommand ?? execa)(binary, ["login", "status"], { reject: false });
  return { loggedIn: result.exitCode === 0 };
}

async function ensureCodexLogin(
  binary: string,
  telemetry: InstallTelemetryState,
  options: CodexCommandOptions & { interactive?: boolean } = {}
): Promise<void> {
  try {
    const status = await checkCodexLoginStatus(binary, { runCommand: options.runCommand });
    if (status.loggedIn) {
      telemetry.codexLoginResult = "logged_in";
      if (options.interactive !== false) {
        p.log.success("Codex 已登录");
      }
      return;
    }
    telemetry.codexLoginResult = "not_logged_in";
  } catch (error) {
    telemetry.codexLoginResult = "error";
    throw error;
  }
  throw new InstallExitError(
    "codex_login_required",
    "Codex 尚未登录。请先执行 `codex login` 完成登录，然后重新运行 `twinny install`。"
  );
}

export function parseCodexVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?)/.exec(output)?.[1];
}

export function compareSemver(left: string, right: string): number {
  const leftParts = left.replace(/[-+].*$/, "").split(".").map((part) => Number(part));
  const rightParts = right.replace(/[-+].*$/, "").split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function buildEnvSelection(env: NodeJS.ProcessEnv): { options: { value: string; label: string; hint?: string }[]; initialValues: string[] } {
  const keys = Object.keys(env)
    .filter((key) => !key.startsWith("TWINNY_") && env[key] !== undefined)
    .sort((left, right) => left.localeCompare(right));
  return {
    options: keys.map((key) => ({
      value: key,
      label: key,
      hint: defaultIncludeEnvKey(key) ? undefined : "默认排除"
    })),
    initialValues: keys.filter(defaultIncludeEnvKey)
  };
}

export function buildServiceEnvironmentStats(
  env: NodeJS.ProcessEnv,
  environment: Record<string, string | undefined>
): ServiceEnvironmentStats {
  const selection = buildEnvSelection(env);
  return {
    importedEnvKeyCount: Object.keys(environment).filter((key) => environment[key] !== undefined).length,
    candidateEnvKeyCount: selection.options.length,
    defaultIncludedEnvKeyCount: selection.initialValues.length
  };
}

export function defaultIncludeEnvKey(key: string): boolean {
  return !sensitiveEnvPattern.test(key) && !terminalEnvKeys.has(key);
}

export function buildServiceEnvironmentForChoice(
  home: string,
  env: NodeJS.ProcessEnv,
  choice: ServiceEnvironmentChoice,
  selectedKeys: string[] = []
): ServiceEnvironmentSelection {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("TWINNY_") && value !== undefined) {
      result[key] = value;
    }
  }
  result.TWINNY_HOME = home;

  const keys = choice === "default" ? buildEnvSelection(env).initialValues : choice === "manual" ? selectedKeys : [];
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  result.TWINNY_HOME = home;
  return { environment: result, stats: buildServiceEnvironmentStats(env, result) };
}

export async function readCodexDefaults(homeDir = os.homedir()): Promise<CodexDefaults> {
  const fallback = { model: "gpt-5.5", effort: "medium" };
  const configPath = path.join(homeDir, ".codex", "config.toml");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return fallback;
    }
    throw error;
  }
  const parsed = parse(raw);
  return {
    model: stringField(parsed, "model") ?? fallback.model,
    effort: stringField(parsed, "model_reasoning_effort") ?? fallback.effort
  };
}

async function promptBotCredentials(): Promise<BotSetupResult> {
  for (;;) {
    const choice = await cancelable(
      p.select<BotChoice>({
        message: "使用什么飞书机器人？",
        options: [
          { value: "auto", label: "一键创建/选择", hint: "推荐" },
          { value: "manual", label: "手动输入 AppID / AppSecret" }
        ],
        initialValue: "auto"
      })
    );
    try {
      const credentials = choice === "auto" ? await createBotWithBrowser() : await promptManualBotCredentials();
      await validateBotCredentials(credentials);
      return { credentials, method: choice };
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function createBotWithBrowser(): Promise<BotCredentials> {
  const begin = await requestLarkAppRegistration(installWizardLarkBrand);
  const verificationUrl = buildLarkVerificationUrl(begin.verificationUriComplete, TWINNY_VERSION);
  p.note(verificationUrl, "在浏览器中完成机器人创建/选择");
  await openBrowserBestEffort(verificationUrl);
  const result = await pollWithEscape("等待浏览器内操作完成，按 Esc 返回上一步", (signal) =>
    pollLarkAppRegistration(installWizardLarkBrand, begin.deviceCode, {
      interval: begin.interval,
      expiresIn: begin.expiresIn,
      signal
    })
  );
  if (!result) {
    throw new Error("已返回机器人选择");
  }
  if (result.brand !== installWizardLarkBrand) {
    throw new Error("Twinny install wizard currently only supports Feishu apps.");
  }
  return {
    appId: result.appId,
    appSecret: result.appSecret,
    brand: installWizardLarkBrand
  };
}

async function createBotWithBrowserForAgent(
  events: InstallAgentEventWriter,
  auth: RunInstallAgentOptions["auth"] = {}
): Promise<BotCredentials> {
  const requestAppRegistration = auth.requestAppRegistration ?? requestLarkAppRegistration;
  const pollAppRegistration = auth.pollAppRegistration ?? pollLarkAppRegistration;
  const begin = await requestAppRegistration(installWizardLarkBrand);
  const verificationUrl = buildLarkVerificationUrl(begin.verificationUriComplete, TWINNY_VERSION);
  events.emit({
    type: "action_required",
    step: "bot_registration",
    verification_url: verificationUrl,
    user_code: begin.userCode,
    expires_in: begin.expiresIn
  });
  const result = await pollAppRegistration(installWizardLarkBrand, begin.deviceCode, {
    interval: begin.interval,
    expiresIn: begin.expiresIn
  });
  if (result.brand !== installWizardLarkBrand) {
    throw new Error("Twinny install currently only supports Feishu apps.");
  }
  return {
    appId: result.appId,
    appSecret: result.appSecret,
    brand: installWizardLarkBrand
  };
}

async function promptManualBotCredentials(): Promise<BotCredentials> {
  const appId = await cancelable(
    p.text({
      message: "App ID",
      validate: (value) => (value?.trim() ? undefined : "App ID is required")
    })
  );
  const appSecret = await cancelable(
    p.password({
      message: "App Secret",
      validate: (value) => (value?.trim() ? undefined : "App Secret is required")
    })
  );
  return {
    appId: appId.trim(),
    appSecret: appSecret.trim(),
    brand: installWizardLarkBrand
  };
}

async function validateBotCredentials(credentials: BotCredentials, options: { interactive?: boolean } = {}): Promise<void> {
  const s = options.interactive === false ? undefined : p.spinner();
  s?.start("校验机器人凭据");
  try {
    const tokenManager = createTenantAccessTokenManager(credentials);
    await tokenManager.getTenantAccessToken({ forceRefresh: true });
    s?.stop("机器人凭据可用");
  } catch (error) {
    s?.error("机器人凭据校验失败");
    throw error;
  }
}

async function promptOwnerIdentity(bot: BotCredentials): Promise<OwnerSetupResult> {
  for (;;) {
    const choice = await cancelable(
      p.select<OwnerChoice>({
        message: "获取 owner 信息",
        options: [
          { value: "browser", label: "通过浏览器授权", hint: "推荐" },
          { value: "manual", label: "手动设置" }
        ],
        initialValue: "browser"
      })
    );
    try {
      const identity = choice === "browser" ? await authorizeOwnerInBrowser(bot) : await promptManualOwner(bot);
      return { identity, method: choice };
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function authorizeOwnerInBrowser(bot: BotCredentials): Promise<OwnerIdentity> {
  const authorization = await requestLarkDeviceAuthorization({
    appId: bot.appId,
    appSecret: bot.appSecret,
    brand: bot.brand
  });
  p.note(authorization.verificationUriComplete, "在浏览器中完成 owner 授权");
  await openBrowserBestEffort(authorization.verificationUriComplete);
  const token = await pollWithEscape("等待 owner 授权完成，按 Esc 返回上一步", (signal) =>
    pollLarkDeviceToken(
      {
        appId: bot.appId,
        appSecret: bot.appSecret,
        brand: bot.brand,
        deviceCode: authorization.deviceCode,
        interval: authorization.interval,
        expiresIn: authorization.expiresIn
      },
      { signal }
    )
  );
  if (!token) {
    throw new Error("已返回 owner 选择");
  }
  const user = await getLarkBrowserUserInfo({ accessToken: token.accessToken, brand: bot.brand });
  return { openId: user.openId, displayName: user.name };
}

async function authorizeOwnerInBrowserForAgent(
  bot: BotCredentials,
  events: InstallAgentEventWriter,
  auth: RunInstallAgentOptions["auth"] = {}
): Promise<OwnerIdentity> {
  const requestDeviceAuthorization = auth.requestDeviceAuthorization ?? requestLarkDeviceAuthorization;
  const pollDeviceToken = auth.pollDeviceToken ?? pollLarkDeviceToken;
  const getBrowserUserInfo = auth.getBrowserUserInfo ?? getLarkBrowserUserInfo;
  const authorization = await requestDeviceAuthorization({
    appId: bot.appId,
    appSecret: bot.appSecret,
    brand: bot.brand
  });
  events.emit({
    type: "action_required",
    step: "owner_authorization",
    verification_url: authorization.verificationUriComplete,
    user_code: authorization.userCode,
    expires_in: authorization.expiresIn
  });
  const token = await pollDeviceToken({
    appId: bot.appId,
    appSecret: bot.appSecret,
    brand: bot.brand,
    deviceCode: authorization.deviceCode,
    interval: authorization.interval,
    expiresIn: authorization.expiresIn
  });
  const user = await getBrowserUserInfo({ accessToken: token.accessToken, brand: bot.brand });
  return { openId: user.openId, displayName: user.name };
}

async function promptManualOwner(bot: BotCredentials): Promise<OwnerIdentity> {
  const openId = await cancelable(
    p.text({
      message: "Owner open_id",
      validate: (value) => (value?.trim() ? undefined : "open_id is required")
    })
  );
  const discoveredName = await lookupOwnerName(bot, openId.trim()).catch(() => undefined);
  if (discoveredName) {
    p.log.success(`Owner: ${discoveredName}`);
    return { openId: openId.trim(), displayName: discoveredName };
  }
  const displayName = await cancelable(
    p.text({
      message: "无法通过 bot 查询到 owner 名称，请手动输入 display name",
      validate: (value) => (value?.trim() ? undefined : "display name is required")
    })
  );
  return { openId: openId.trim(), displayName: displayName.trim() };
}

async function lookupOwnerName(bot: BotCredentials, openId: string): Promise<string | undefined> {
  const openApiClient = createOpenApiClient(bot);
  return new LarkUserDirectory({ openApiClient }).getUserNameByOpenId(openId);
}

async function promptServiceEnvironment(
  home: string,
  env: NodeJS.ProcessEnv,
  telemetry: InstallTelemetryState,
  serviceDisplayName = managedServiceDisplayName()
): Promise<ServiceEnvironmentSelection> {
  const selection = buildEnvSelection(env);
  const choice = await cancelable(
    p.select<ServiceEnvironmentChoice>({
      message: `导入环境变量到 ${serviceDisplayName}`,
      options: [
        { value: "default", label: "导入默认", hint: "推荐" },
        { value: "manual", label: "手动选择" },
        { value: "none", label: "不导入" }
      ],
      initialValue: "default"
    })
  );
  telemetry.serviceEnvironmentChoice = choice;
  if (choice === "default" || choice === "none") {
    return buildServiceEnvironmentForChoice(home, env, choice);
  }
  if (selection.options.length === 0) {
    return buildServiceEnvironmentForChoice(home, env, "manual");
  }
  const selected = await cancelable(
    p.multiselect<string>({
      message: "选择要导入的环境变量",
      options: selection.options,
      initialValues: selection.initialValues,
      required: false,
      maxItems: 14
    })
  );
  return buildServiceEnvironmentForChoice(home, env, "manual", selected);
}

async function finalizeInstall(input: {
  config: TwinnyConfig;
  appSecret: string;
  environment: Record<string, string | undefined>;
  result: FinalizeInstallResult;
  telemetry: InstallTelemetryState;
  secretStore?: SecretStore;
  interactive?: boolean;
  larkCliInstallPreference?: InstallAgentAutoPreference;
  runCommand?: CommandRunner;
  resolveServiceEntrypoint?: (home: string) => Promise<string>;
  installManagedService?: InstallManagedServiceFn;
  uploadBundledAssets?: UploadBundledAssetsFn;
  onProgress?: (
    step: Extract<InstallAgentStep, "config" | "asset_upload" | "lark_cli">,
    status: "started" | "completed" | "skipped",
    detail?: Record<string, unknown>
  ) => void;
  platform?: NodeJS.Platform;
  disableKeychain?: boolean;
}): Promise<void> {
  const interactive = input.interactive !== false;
  const platform = input.platform ?? process.platform;
  const serviceDisplayName = installManagedServiceDisplayName(platform, input.config.service);
  const useKeychain = platform === "darwin" && !input.disableKeychain;
  input.onProgress?.("config", "started");
  if (interactive) {
    p.log.info("初始化 Twinny home");
  }
  try {
    const entrypoint = await (input.resolveServiceEntrypoint ?? resolveServiceEntrypoint)(input.config.home);
    const paths = createRuntimePaths(input.config.home);
    const configForAuth = useKeychain ? input.config : configWithLarkAppSecret(input.config, input.appSecret);
    const bootstrap = await bootstrapTwinnyHome(configForAuth);
    input.result.homeCreated = true;
    input.result.wroteHomeRandom = bootstrap.wroteHomeRandom;
    input.result.wroteConfig = bootstrap.wroteConfig;
    input.result.wroteAuth = bootstrap.wroteAuth;
    if (useKeychain) {
      try {
        await (input.secretStore ?? createDefaultSecretStore({ paths })).set(
          input.config.homeIdentity.keychainAccounts.larkAppSecret,
          input.appSecret
        );
      } catch {
        await writeTwinnyAuthFile(configWithLarkAppSecret(input.config, input.appSecret).auth, paths.authFile);
        if (interactive) {
          p.log.warn("macOS Keychain 写入失败，已改写入 auth.json");
        }
      }
    }
    await (input.installManagedService ?? installManagedService)({
      config: input.config,
      entrypoint,
      environment: input.environment
    });
    input.result.serviceInstalled = true;
    if (interactive) {
      p.log.success(`Twinny home 和 ${serviceDisplayName} 已创建`);
    }
    input.onProgress?.("config", "completed");
  } catch (error) {
    if (interactive) {
      p.log.error("初始化失败");
    }
    throw error;
  }

  input.onProgress?.("asset_upload", "started");
  if (interactive) {
    p.log.info("上传 Twinny 资源");
  }
  input.result.assetUploadAttempted = true;
  try {
    await (input.uploadBundledAssets ?? uploadBundledAssets)(input.config, input.appSecret, {
      logger: interactive ? undefined : { warn: () => undefined }
    });
    input.telemetry.assetUploadResult = "succeeded";
  } catch (error) {
    input.telemetry.assetUploadResult = "failed";
    throw error;
  }
  if (interactive) {
    p.log.success("资源上传步骤完成");
  }
  input.onProgress?.("asset_upload", "completed");

  input.onProgress?.("lark_cli", "started");
  const larkCliSetup = interactive
    ? await promptLarkCliProfileSetup(input.config, input.appSecret, input.telemetry)
    : await setupLarkCliProfileForAgent({
      config: input.config,
      appSecret: input.appSecret,
      telemetry: input.telemetry,
      installPreference: input.larkCliInstallPreference ?? "auto",
      runCommand: input.runCommand
    });
  input.result.larkCliProfilePersisted = larkCliSetup.profilePersisted;
  input.onProgress?.("lark_cli", larkCliSetup.profilePersisted ? "completed" : "skipped");
}

async function uploadBundledAssets(
  config: TwinnyConfig,
  appSecret: string,
  options: { logger?: { warn: (...args: unknown[]) => void } } = {}
): Promise<void> {
  const paths = createRuntimePaths(config.home);
  const larkFiles = new LarkFileDownloader({ openApiClient: createOpenApiClient({ appId: config.auth.larkAppId, appSecret, brand: config.auth.larkBrand }) });
  await provisionLarkAssetImageKeys({
    cacheFile: paths.larkAssetsFile,
    logoFilePath: resolveBundledLogoPath(),
    bannerFilePath: resolveBundledBannerPath(),
    uploader: larkFiles,
    logger: options.logger ?? {
      warn: (_metadataOrMessage?: unknown, message?: string) =>
        p.log.warn(message ?? "failed to upload lark asset image; continuing without it")
    }
  });
}

async function promptLarkCliProfileSetup(
  config: TwinnyConfig,
  appSecret: string,
  telemetry: InstallTelemetryState
): Promise<LarkCliProfileSetupResult> {
  let binary = await detectLarkCliBinary({ telemetry });
  if (!binary) {
    const shouldInstall = await cancelable(
      p.confirm({
        message: "未检测到 lark-cli。是否自动安装 lark-cli？",
        initialValue: true
      })
    );
    if (!shouldInstall) {
      telemetry.larkCliInstallChoice = "declined";
      telemetry.larkCliProfileListResult = "skipped";
      p.log.info("已跳过 lark-cli 配置");
      return { profilePersisted: false };
    }
    telemetry.larkCliInstallChoice = "accepted";
    await installLarkCli({ telemetry });
    binary = await detectLarkCliBinary({ telemetry });
    if (!binary) {
      throw new Error("lark-cli install completed, but lark-cli was not found in PATH");
    }
  } else {
    p.log.success(`lark-cli 已安装：${binary}`);
  }

  const profileSetup = await ensureLarkCliProfile({
    binary,
    appId: config.auth.larkAppId,
    appSecret,
    brand: config.auth.larkBrand,
    home: config.home,
    telemetry,
    config
  });
  if (profileSetup.profileName) {
    p.log.success(
      profileSetup.profileStatus === "created"
        ? `lark-cli profile 已创建：${profileSetup.profileName}`
        : `lark-cli profile 已存在：${profileSetup.profileName}`
    );
  }
  return profileSetup;
}

async function setupLarkCliProfileForAgent(input: {
  config: TwinnyConfig;
  appSecret: string;
  telemetry: InstallTelemetryState;
  installPreference: InstallAgentAutoPreference;
  runCommand?: CommandRunner;
}): Promise<LarkCliProfileSetupResult> {
  let binary = await detectLarkCliBinary({ telemetry: input.telemetry, runCommand: input.runCommand });
  if (!binary) {
    if (input.installPreference === "never") {
      input.telemetry.larkCliInstallChoice = "declined";
      input.telemetry.larkCliProfileListResult = "skipped";
      return { profilePersisted: false };
    }
    input.telemetry.larkCliInstallChoice = "accepted";
    await installLarkCli({ telemetry: input.telemetry, runCommand: input.runCommand, interactive: false });
    binary = await detectLarkCliBinary({ telemetry: input.telemetry, runCommand: input.runCommand });
    if (!binary) {
      throw new Error("lark-cli install completed, but lark-cli was not found in PATH");
    }
  }

  return ensureLarkCliProfile({
    binary,
    appId: input.config.auth.larkAppId,
    appSecret: input.appSecret,
    brand: input.config.auth.larkBrand,
    home: input.config.home,
    runCommand: input.runCommand,
    telemetry: input.telemetry,
    config: input.config
  });
}

export async function detectLarkCliBinary(options: {
  runCommand?: CommandRunner;
  telemetry?: InstallTelemetryState;
} = {}): Promise<string | undefined> {
  try {
    const result = await (options.runCommand ?? execa)("which", ["lark-cli"], { reject: false });
    const binary = result.stdout.trim().split("\n")[0] || undefined;
    options.telemetry && (options.telemetry.larkCliDetectResult = binary ? "found" : "missing");
    return binary;
  } catch (error) {
    options.telemetry && (options.telemetry.larkCliDetectResult = "error");
    throw error;
  }
}

function configWithLarkAppSecret(config: TwinnyConfig, appSecret: string): TwinnyConfig {
  return {
    ...config,
    auth: {
      ...config.auth,
      larkAppSecret: appSecret
    }
  };
}

export async function installLarkCli(options: {
  runCommand?: CommandRunner;
  telemetry?: InstallTelemetryState;
  interactive?: boolean;
} = {}): Promise<void> {
  const s = options.interactive === false ? undefined : p.spinner();
  s?.start("安装 lark-cli");
  try {
    await (options.runCommand ?? execa)("npx", ["@larksuite/cli@latest", "install"], { stdio: "pipe" });
    options.telemetry && (options.telemetry.larkCliInstallResult = "succeeded");
    s?.stop("lark-cli 已安装");
  } catch (error) {
    options.telemetry && (options.telemetry.larkCliInstallResult = "failed");
    s?.error("lark-cli 安装失败");
    const output = childProcessErrorOutput(error);
    throw new Error(output ? `failed to install lark-cli:\n${output}` : "failed to install lark-cli", { cause: error });
  }
}

export interface LarkCliProfileListItem {
  name: string;
  appId?: string;
  brand?: string;
  active?: boolean;
  user?: string;
  tokenStatus?: string;
}

export function parseLarkCliProfileList(output: string): LarkCliProfileListItem[] {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("lark-cli profile list did not return a JSON array");
  }
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("lark-cli profile list returned an invalid profile item");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.trim().length === 0) {
      throw new Error("lark-cli profile list returned a profile without name");
    }
    return {
      name: record.name,
      ...(typeof record.appId === "string" ? { appId: record.appId } : {}),
      ...(typeof record.brand === "string" ? { brand: record.brand } : {}),
      ...(typeof record.active === "boolean" ? { active: record.active } : {}),
      ...(typeof record.user === "string" ? { user: record.user } : {}),
      ...(typeof record.tokenStatus === "string" ? { tokenStatus: record.tokenStatus } : {})
    };
  });
}

export async function ensureLarkCliProfile(input: {
  binary: string;
  appId: string;
  appSecret: string;
  brand: LarkBrand;
  home: string;
  runCommand?: CommandRunner;
  telemetry?: InstallTelemetryState;
  config?: TwinnyConfig;
}): Promise<LarkCliProfileSetupResult> {
  const runCommand = input.runCommand ?? execa;
  const listResult = await runCommand(input.binary, ["profile", "list"], { reject: false });
  if (listResult.exitCode !== 0) {
    input.telemetry && (input.telemetry.larkCliProfileListResult = "error");
    const output = childProcessErrorOutput(listResult);
    throw new Error(output ? `failed to list lark-cli profiles:\n${output}` : "failed to list lark-cli profiles");
  }

  let profiles: LarkCliProfileListItem[];
  try {
    profiles = parseLarkCliProfileList(listResult.stdout);
  } catch (error) {
    input.telemetry && (input.telemetry.larkCliProfileListResult = "error");
    throw error;
  }
  const existing = profiles.find((profile) => profile.name === input.appId);
  if (existing) {
    input.telemetry && (input.telemetry.larkCliProfileListResult = "profile_found");
    await persistLarkCliProfileName(input.home, existing.name, input.telemetry, input.config);
    return { profileName: existing.name, profilePersisted: true, profileStatus: "existing" };
  }

  input.telemetry && (input.telemetry.larkCliProfileListResult = "profile_missing");
  const addResult = await runCommand(
    input.binary,
    ["profile", "add", "--name", input.appId, "--app-id", input.appId, "--app-secret-stdin", "--brand", input.brand],
    {
      input: `${input.appSecret}\n`,
      reject: false
    }
  );
  if (addResult.exitCode !== 0) {
    input.telemetry && (input.telemetry.larkCliProfileAddResult = "failed");
    const output = childProcessErrorOutput(addResult);
    throw new Error(output ? `failed to add lark-cli profile:\n${output}` : "failed to add lark-cli profile");
  }

  input.telemetry && (input.telemetry.larkCliProfileAddResult = "succeeded");
  await persistLarkCliProfileName(input.home, input.appId, input.telemetry, input.config);
  return { profileName: input.appId, profilePersisted: true, profileStatus: "created" };
}

async function persistLarkCliProfileName(
  home: string,
  profileName: string,
  telemetry?: InstallTelemetryState,
  config?: TwinnyConfig
): Promise<void> {
  const profile = { profileName };
  await writeLarkCliProfileConfig(profile, createRuntimePaths(home).larkCliProfileFile);
  telemetry && (telemetry.larkCliProfileName = profileName);
  if (config) {
    config.larkCliProfile = profile;
  }
}

function createTenantAccessTokenManager(credentials: BotCredentials): TenantAccessTokenManager {
  return new TenantAccessTokenManager({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    baseUrl: resolveLarkEndpoints(credentials.brand).openApi
  });
}

function createOpenApiClient(credentials: BotCredentials): LarkOpenApiClient {
  const tokenManager = createTenantAccessTokenManager(credentials);
  return new LarkOpenApiClient({
    tokenManager,
    baseUrl: resolveLarkEndpoints(credentials.brand).openApi
  });
}

interface ResolveServiceEntrypointOptions {
  entrypoint?: string;
  runNpmInstall?: typeof execa;
}

export async function resolveServiceEntrypoint(home: string, options: ResolveServiceEntrypointOptions = {}): Promise<string> {
  const entrypoint = path.resolve(options.entrypoint ?? process.argv[1] ?? process.execPath);
  if (!isNpxEntrypoint(entrypoint)) {
    return entrypoint;
  }
  const identity = await readPackageIdentity();
  const runnerDir = path.join(home, "runner");
  try {
    await (options.runNpmInstall ?? execa)("npm", ["install", "--prefix", runnerDir, "--omit=dev", "--no-audit", "--no-fund", `${identity.name}@${identity.version}`], {
      stdio: "pipe"
    });
  } catch (error) {
    const output = childProcessErrorOutput(error);
    throw new Error(
      output
        ? `failed to install ${identity.name}@${identity.version} for managed service runner:\n${output}`
        : `failed to install ${identity.name}@${identity.version} for managed service runner`,
      { cause: error }
    );
  }
  return path.join(runnerDir, "node_modules", ".bin", "twinny");
}

export function isNpxEntrypoint(entrypoint: string): boolean {
  return entrypoint.split(path.sep).includes("_npx");
}

async function readPackageIdentity(): Promise<{ name: string; version: string }> {
  const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const raw = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
  if (typeof raw.name !== "string" || typeof raw.version !== "string") {
    throw new Error("package.json is missing name or version");
  }
  return { name: raw.name, version: raw.version };
}

function childProcessErrorOutput(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const record = error as { shortMessage?: unknown; stderr?: unknown; stdout?: unknown };
  return [record.shortMessage, record.stderr, record.stdout]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .filter((value, index, values) => values.indexOf(value) === index)
    .join("\n");
}

async function pollWithEscape<T>(message: string, run: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const controller = new AbortController();
  const cleanup = installEscapeAbort(controller);
  const s = p.spinner();
  s.start(message);
  try {
    const result = await run(controller.signal);
    s.stop("完成");
    return result;
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      s.cancel("已取消");
      return undefined;
    }
    s.error("失败");
    throw error;
  } finally {
    cleanup();
  }
}

function installEscapeAbort(controller: AbortController): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return () => undefined;
  }
  const wasRaw = stdin.isRaw;
  const onData = (chunk: Buffer) => {
    if (chunk.includes(0x1b)) {
      controller.abort();
    }
  };
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  return () => {
    stdin.off("data", onData);
    stdin.setRawMode(wasRaw);
  };
}

async function openBrowserBestEffort(url: string): Promise<void> {
  if (process.platform === "darwin") {
    await execa("open", [url], { reject: false });
    return;
  }
  if (process.platform === "win32") {
    await execa("cmd", ["/c", "start", "", url], { reject: false });
    return;
  }
  await execa("xdg-open", [url], { reject: false });
}

async function cancelable<T>(value: Promise<T | symbol>): Promise<T> {
  const result = await value;
  if (p.isCancel(result)) {
    p.cancel("安装已取消");
    process.exit(0);
  }
  return result;
}

function stringField(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
