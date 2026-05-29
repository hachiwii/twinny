import type { Logger } from "pino";
import path from "node:path";
import {
  createRuntimePaths,
  createDefaultSecretStore,
  loadTwinnyConfig,
  resolveBundledBannerPath,
  resolveBundledLogoPath,
  resolveLarkAppSecret,
  type SecretStore
} from "../config/index.js";
import { ProfileCodexAppServerPool, type CodexAppServer } from "../codex/index.js";
import { ConversationManager, type CodexBridge, type ConversationQueueOptions } from "../conversation/manager.js";
import {
  LarkEventConsumer,
  LarkFileDownloader,
  LarkMessageReader,
  LarkMessageSender,
  LarkDocClient,
  LarkBotDirectory,
  LarkChatDirectory,
  LarkUserDirectory,
  LarkFeatureConfigurationChecker,
  LarkOpenApiClient,
  resolveLarkEndpoints,
  resolveLarkEventDomain,
  type LarkSdkLogger,
  TenantAccessTokenManager
} from "../lark/index.js";
import { acquireTwinnyLock, type TwinnyRuntimeLock } from "../lock/index.js";
import { createLarkSdkLogger, createLogger, logger as defaultLogger } from "../observability/logs.js";
import { TwinnySystemNotifier } from "../observability/system-notifications.js";
import { getProfileCodexHome } from "../profiles/index.js";
import { createConversationRepository, openRuntimeDatabase, type ConversationRepository, type TwinnyDatabase } from "../store/index.js";
import {
  createTwinnyTelemetryClient,
  memoryUsageTelemetryProperties,
  type TelemetryClient
} from "../telemetry/index.js";
import type {
  CodexAgentMessage,
  CodexErrorNotification,
  CodexImageGeneration,
  CodexPlanUpdate,
  CodexRequestUserInputRequest,
  CodexThreadMode,
  CodexThreadTokenUsageUpdate,
  LarkReactionHandle,
  ProfileName,
  TwinnyConfig
} from "../types.js";
import type {
  CodexDynamicToolCallResponse,
  CodexRequestUserInputResponder,
  CodexSetThreadNameToolRequest,
  CodexTwinnyDynamicToolRequest,
  CodexTurnInput
} from "../codex/turn.js";
import type { ThreadListParams } from "../codex/thread.js";
import { WorkspaceManager } from "../workspace/index.js";
import { MacIdleSleepPreventer, type IdleSleepPreventer } from "./caffeinate.js";
import {
  provisionLarkAssetImageKeys as provisionRuntimeLarkAssetImageKeys,
  type LarkAssetImageKeys
} from "./lark-assets.js";
import { recordStartupErrorTelemetryAttempt } from "./startup-error-telemetry.js";

export interface TwinnyRuntimeOptions {
  logger?: Logger;
  larkSdkLogger?: LarkSdkLogger;
  requestTimeoutMs?: number;
  logoFilePath?: string;
  bannerFilePath?: string;
  idleSleepPreventer?: IdleSleepPreventer;
  telemetry?: TelemetryClient;
  heartbeatIntervalMs?: number;
  disableHeartbeat?: boolean;
}

export class TwinnyRuntime {
  private readonly log: Logger;
  private readonly larkSdkLogger: LarkSdkLogger;
  private readonly paths;
  private readonly secretStore: SecretStore;
  private lock?: TwinnyRuntimeLock;
  private db?: TwinnyDatabase;
  private codexPool?: ProfileCodexAppServerPool;
  private idleSleepPreventer?: IdleSleepPreventer;
  private larkConsumer?: LarkEventConsumer;
  private conversation?: ConversationManager;
  private systemNotifier?: TwinnySystemNotifier;
  private readonly codexRecoveryByProfile = new Map<ProfileName, Promise<void>>();
  private readonly codexIntentionalStopByProfile = new Set<ProfileName>();
  private readonly telemetry: TelemetryClient;
  private heartbeatTimer?: NodeJS.Timeout;
  private runtimeStartedAt = 0;
  private stopped = false;
  private stopPromise: Promise<void>;
  private resolveStopped!: () => void;

  constructor(
    private readonly config: TwinnyConfig,
    private readonly options: TwinnyRuntimeOptions = {}
  ) {
    this.log = options.logger ?? defaultLogger;
    this.paths = createRuntimePaths(config.home);
    this.secretStore = createDefaultSecretStore({ paths: this.paths });
    this.larkSdkLogger =
      options.larkSdkLogger ??
      createLarkSdkLogger(createLogger({ logFile: path.join(this.paths.logsDir, "lark-sdk.log") }));
    this.telemetry =
      options.telemetry ??
      createTwinnyTelemetryClient(config, {
        logger: this.log,
        codexVersion: () => this.readRuntimeCodexVersion()
      });
    this.stopPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  async start(): Promise<void> {
    const launchStartedAt = Date.now();
    this.runtimeStartedAt = launchStartedAt;
    let lockAcquired = false;
    let dbOpened = false;
    let recoveryAttempted = false;
    let larkConsumerStarted = false;
    try {
      this.lock = await acquireTwinnyLock(this.paths, { stale: 30_000, update: 10_000 });
      lockAcquired = true;
      this.idleSleepPreventer = this.options.idleSleepPreventer ?? new MacIdleSleepPreventer({ logger: this.log });
      this.idleSleepPreventer.start();
      this.db = openRuntimeDatabase(this.paths);
      dbOpened = true;

      const appSecretAccount = this.config.homeIdentity.keychainAccounts.larkAppSecret;
      const appSecret = await resolveLarkAppSecret(appSecretAccount, this.secretStore, process.env, this.config.auth.larkAppSecret);
      if (!appSecret) {
        throw new Error(`Lark app secret is missing: auth.json lark_app_secret or keychain:${appSecretAccount}`);
      }
      this.codexPool = new ProfileCodexAppServerPool({
        binary: this.config.codex.binary,
        profiles: this.config.profiles,
        masqueradeAsCodexCli: this.config.codex.masqueradeAsCodexCli,
        requestTimeoutMs: this.options.requestTimeoutMs ?? 10 * 60 * 1000
      });
      for (const profile of Object.keys(this.config.profiles) as ProfileName[]) {
        this.attachCodexAppServerListeners(profile, this.codexPool.get(profile));
      }
      await this.codexPool.startAll();

      const tokenManager = new TenantAccessTokenManager({
        appId: this.config.auth.larkAppId,
        appSecret,
        baseUrl: resolveLarkEndpoints(this.config.auth.larkBrand).openApi
      });
      const openApiClient = new LarkOpenApiClient({
        tokenManager,
        baseUrl: resolveLarkEndpoints(this.config.auth.larkBrand).openApi
      });
      const larkSender = new LarkMessageSender({
        openApiClient,
        logger: this.log,
        redaction: this.config.lark.messageRedaction
      });
      const larkMessages = new LarkMessageReader({ openApiClient });
      const larkUsers = new LarkUserDirectory({ openApiClient });
      const larkChats = new LarkChatDirectory({ openApiClient });
      const larkBot = new LarkBotDirectory({ openApiClient });
      const botOpenId = await larkBot.getBotOpenId().catch((error) => {
        this.log.warn({ error }, "failed to resolve lark bot open_id; group @mention matching will be unavailable");
        return undefined;
      });
      const larkFiles = new LarkFileDownloader({ openApiClient });
      const larkDocs = new LarkDocClient({ openApiClient });
      const assetImageKeys = await this.provisionLarkAssetImageKeys(larkFiles);
      const larkFeatureConfig = new LarkFeatureConfigurationChecker({
        appId: this.config.auth.larkAppId,
        openApiClient,
        logger: this.log
      });
      const systemNotifier = new TwinnySystemNotifier({
        ownerOpenId: this.config.owner.openId,
        sender: larkSender,
        logger: this.log
      });
      this.systemNotifier = systemNotifier;
      const startupFeatureChecks = await larkFeatureConfig.checkAllFeatureSets();
      await systemNotifier.notifyMissingLarkConfiguration(
        startupFeatureChecks.filter((result) => result.key === "necessary")
      );
      const repository = createConversationRepository(this.db);
      const workspaceManager = WorkspaceManager.fromRuntimePaths(this.paths);
      const conversation = new ConversationManager({
        config: this.config,
        repository: adaptConversationRepository(repository),
        workspaces: workspaceManager,
        codex: adaptCodexPool(this.codexPool),
        lark: adaptLarkSender(
          larkSender,
          this.config.lark.workingReaction,
          this.config.lark.completedReaction,
          this.config.lark.queuedReaction
        ),
        larkUsers,
        larkChats,
        larkFiles,
        larkMessages,
        larkDocs,
        larkDocComments: larkDocs,
        larkFeatureConfig,
        botOpenId,
        assetImageKeys,
        profiles: { codexHomeFor: (profile) => getProfileCodexHome(this.config, profile) },
        runtime: { reloadProfile: (profile, options) => this.reloadProfile(profile, options) },
        telemetry: this.telemetry,
        logger: this.log
      });
      this.conversation = conversation;
      recoveryAttempted = true;
      await conversation.recoverUnfinishedMessages();
      await conversation.startCronScheduler();

      this.larkConsumer = new LarkEventConsumer({
        appId: this.config.auth.larkAppId,
        appSecret,
        tokenManager,
        domain: resolveLarkEventDomain(this.config.auth.larkBrand),
        botOpenId,
        logger: this.log,
        sdkLogger: this.larkSdkLogger,
        maxMessageAgeMs: this.config.lark.maxMessageAgeSeconds * 1000,
        onMessage: (message) => {
          conversation.submitIncoming(message);
        },
        onMessageRecall: (recall) => {
          conversation.submitMessageRecall(recall);
        },
        onDocCommentAdd: (comment) => {
          conversation.submitDocCommentAdd(comment);
        },
        onBotMenu: (action) => {
          conversation.submitBotMenuAction(action);
        },
        onCardAction: (action) => {
          conversation.submitCardAction(action);
        },
        onConnectionError: (error) => {
          this.telemetry.captureError(error, {
            errorType: "lark_event",
            errorSite: "lark.eventConsumer.connection",
            operation: "connection_error",
            fatal: false
          });
        },
        onIgnored: (reason) => this.log.debug({ reason }, "lark event ignored")
      });
      await this.larkConsumer.start();
      larkConsumerStarted = true;
      await this.systemNotifier.notifyInitialized({ bannerImageKey: assetImageKeys.bannerImageKey });
      this.telemetry.capture(
        "twinny_launch",
        {
          launch_duration_ms: Date.now() - launchStartedAt,
          codex_profile_count: this.codexPool.listProfiles().length,
          lark_consumer_started: larkConsumerStarted,
          lark_ready: this.larkConsumer.isReady,
          has_bot_open_id: botOpenId !== undefined,
          db_opened: dbOpened,
          lock_acquired: lockAcquired,
          recovery_attempted: recoveryAttempted,
          ...memoryUsageTelemetryProperties()
        },
        {
          insertId: `twinny_launch:${this.telemetry.runtimeId}`,
          codexVersion: this.readRuntimeCodexVersion()
        }
      );
      this.startHeartbeat();
      this.log.info({ home: this.config.home }, "twinny daemon started");
    } catch (error) {
      const startupErrorTelemetry = await recordStartupErrorTelemetryAttempt(this.paths, error, {
        errorType: "runtime_start",
        errorSite: "runtime.start",
        operation: "start"
      });
      if (startupErrorTelemetry.throttleStateError) {
        this.log.warn({ error: startupErrorTelemetry.throttleStateError }, "failed to update startup error telemetry throttle state");
      }
      if (startupErrorTelemetry.capture) {
        this.telemetry.captureError(error, {
          errorType: "runtime_start",
          errorSite: "runtime.start",
          operation: "start",
          fatal: true,
          insertId: startupErrorTelemetry.insertId,
          properties: {
            launch_duration_ms: Date.now() - launchStartedAt,
            lark_consumer_started: larkConsumerStarted,
            db_opened: dbOpened,
            lock_acquired: lockAcquired,
            recovery_attempted: recoveryAttempted,
            ...startupErrorTelemetry.properties
          }
        });
      } else {
        this.log.warn(
          { startupErrorFingerprint: startupErrorTelemetry.fingerprint },
          "suppressed repeated startup error telemetry"
        );
      }
      await this.cleanupAfterStartFailure(error);
      throw error;
    }
  }

  private async cleanupAfterStartFailure(error: unknown): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.log.error({ error }, "twinny daemon failed to start; cleaning up");
    try {
      await this.shutdownConversation();
      await this.stopLarkConsumer();
      await this.stopCodexPool("SIGTERM");
      this.closeDatabase();
    } finally {
      await this.releaseLock();
      await this.stopIdleSleepPreventer();
      await this.shutdownTelemetry();
      this.resolveStopped();
    }
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.log.info({ signal }, "stopping twinny daemon");
    try {
      this.stopHeartbeat();
      await this.shutdownConversation();
      await this.stopLarkConsumer();
      await this.stopCodexPool(signal);
      this.closeDatabase();
    } finally {
      await this.releaseLock();
      await this.stopIdleSleepPreventer(signal);
      await this.shutdownTelemetry();
      this.resolveStopped();
    }
  }

  async wait(): Promise<void> {
    await this.stopPromise;
  }

  private async handleCodexAppServerExit(profile: ProfileName): Promise<void> {
    if (this.stopped) {
      return;
    }
    const existing = this.codexRecoveryByProfile.get(profile);
    if (existing) {
      return existing;
    }
    const recovery = this.recoverCodexAppServer(profile).finally(() => {
      if (this.codexRecoveryByProfile.get(profile) === recovery) {
        this.codexRecoveryByProfile.delete(profile);
      }
    });
    this.codexRecoveryByProfile.set(profile, recovery);
    await recovery;
  }

  private async recoverCodexAppServer(profile: ProfileName): Promise<void> {
    const pool = this.codexPool;
    if (!pool || this.stopped) {
      return;
    }
    const suspended = (await this.conversation?.suspendActiveTurnsForCodexAppServerExit(profile)) ?? 0;
    this.log.warn({ profile, suspended }, "recovering codex app-server after exit");
    try {
      await pool.restart(profile);
      if (this.stopped) {
        return;
      }
      const recovered = (await this.conversation?.recoverSuspendedActiveTurnsForCodexAppServerExit(profile)) ?? 0;
      this.log.info({ profile, suspended, recovered }, "codex app-server recovered after exit");
    } catch (error) {
      this.telemetry.captureError(error, {
        errorType: "codex_app_server",
        errorSite: "runtime.recoverCodexAppServer",
        operation: "recover_codex_app_server",
        fatal: false,
        properties: { profile, suspended }
      });
      throw error;
    }
  }

  private attachCodexAppServerListeners(profile: ProfileName, server: CodexAppServer): void {
    server.on("stderr", (chunk) => {
      this.log.debug({ profile, stream: "stderr", chunk }, "codex app-server stderr");
    });
    server.on("threadNameUpdated", (update) => {
      this.conversation?.submitCodexThreadNameUpdated(update);
    });
    server.on("exit", (code, signal) => {
      if (this.codexIntentionalStopByProfile.delete(profile) || this.stopped) {
        this.log.info({ profile, code, signal }, "codex app-server stopped intentionally");
        return;
      }
      this.log.error({ profile, code, signal }, "codex app-server exited");
      this.telemetry.captureError(new Error("Codex app-server exited"), {
        errorType: "codex_app_server",
        errorSite: "runtime.codexAppServer.exit",
        operation: "codex_app_server_exit",
        fatal: false,
        properties: { profile, code, signal }
      });
      void this.handleCodexAppServerExit(profile).catch((error) => {
        this.log.error({ error, profile }, "failed to recover codex app-server after exit");
      });
    });
  }

  async reloadProfile(profile?: ProfileName, options: ConversationQueueOptions = {}): Promise<void> {
    const pool = this.codexPool;
    if (!pool) {
      throw new Error("Codex app-server pool is not started");
    }
    if (profile === "none") {
      throw new Error("profile none is reserved");
    }

    const nextConfig = await loadTwinnyConfig({ home: this.config.home });
    if (profile && !nextConfig.profiles[profile]) {
      throw new Error(`Unknown profile: ${profile}`);
    }

    const currentProfiles = new Set(pool.listProfiles());
    const nextProfiles = new Set(Object.keys(nextConfig.profiles) as ProfileName[]);
    const profilesToReload = profile
      ? [profile]
      : Array.from(new Set<ProfileName>([...currentProfiles, ...nextProfiles]));

    this.log.info({ profiles: profilesToReload }, "reloading twinny profiles");
    for (const profileName of profilesToReload) {
      const nextProfile = nextConfig.profiles[profileName];
      if (!nextProfile) {
        if (currentProfiles.has(profileName)) {
          await this.stopCodexAppServerForReload(pool, profileName);
        }
        continue;
      }

      const suspended = currentProfiles.has(profileName)
        ? (await this.conversation?.suspendActiveTurnsForCodexAppServerExit(profileName, options)) ?? 0
        : 0;
      if (currentProfiles.has(profileName)) {
        await this.stopCodexAppServerForReload(pool, profileName);
      }
      const server = pool.replace(profileName, {
        binary: nextConfig.codex.binary,
        codexHome: nextProfile.codexHome
      });
      this.attachCodexAppServerListeners(profileName, server);
      await server.start();
      const recovered = currentProfiles.has(profileName)
        ? (await this.conversation?.recoverSuspendedActiveTurnsForCodexAppServerExit(profileName, options)) ?? 0
        : 0;
      this.log.info({ profile: profileName, suspended, recovered }, "reloaded codex app-server profile");
    }

    replaceTwinnyConfigContents(this.config, nextConfig);
  }

  private async stopCodexAppServerForReload(pool: ProfileCodexAppServerPool, profile: ProfileName): Promise<void> {
    this.codexIntentionalStopByProfile.add(profile);
    try {
      await pool.remove(profile);
    } finally {
      this.codexIntentionalStopByProfile.delete(profile);
    }
  }

  private async shutdownConversation(): Promise<void> {
    if (!this.conversation) {
      return;
    }
    const conversation = this.conversation;
    this.conversation = undefined;
    try {
      await conversation.shutdown();
    } catch (error) {
      this.log.warn({ error }, "failed to shutdown conversation manager cleanly");
    }
  }

  private async stopLarkConsumer(): Promise<void> {
    if (!this.larkConsumer) {
      return;
    }
    const consumer = this.larkConsumer;
    this.larkConsumer = undefined;
    try {
      await consumer.stop({ force: true });
    } catch (error) {
      this.log.warn({ error }, "failed to stop lark event consumer cleanly");
    }
  }

  private async stopCodexPool(signal: NodeJS.Signals): Promise<void> {
    if (!this.codexPool) {
      return;
    }
    const pool = this.codexPool;
    this.codexPool = undefined;
    const profiles = pool.listProfiles();
    for (const profile of profiles) {
      this.codexIntentionalStopByProfile.add(profile);
    }
    try {
      await pool.stopAll(signal);
    } catch (error) {
      this.log.warn({ error }, "failed to stop codex app-server pool cleanly");
    } finally {
      for (const profile of profiles) {
        this.codexIntentionalStopByProfile.delete(profile);
      }
    }
  }

  private closeDatabase(): void {
    if (!this.db) {
      return;
    }
    const db = this.db;
    this.db = undefined;
    try {
      db.close();
    } catch (error) {
      this.log.warn({ error }, "failed to close sqlite database cleanly");
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.lock) {
      return;
    }
    const lock = this.lock;
    this.lock = undefined;
    try {
      await lock.release();
    } catch (error) {
      this.log.warn({ error }, "failed to release runtime lock cleanly");
    }
  }

  private async stopIdleSleepPreventer(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.idleSleepPreventer) {
      return;
    }
    const preventer = this.idleSleepPreventer;
    this.idleSleepPreventer = undefined;
    try {
      await preventer.stop(signal);
    } catch (error) {
      this.log.warn({ error }, "failed to stop caffeinate idle sleep assertion cleanly");
    }
  }

  private async provisionLarkAssetImageKeys(larkFiles: LarkFileDownloader): Promise<LarkAssetImageKeys> {
    return provisionRuntimeLarkAssetImageKeys({
      cacheFile: this.paths.larkAssetsFile,
      logoFilePath: this.options.logoFilePath ?? resolveBundledLogoPath(),
      bannerFilePath: this.options.bannerFilePath ?? resolveBundledBannerPath(),
      uploader: larkFiles,
      logger: this.log
    });
  }

  private startHeartbeat(): void {
    if (this.options.disableHeartbeat) {
      return;
    }
    const intervalMs = this.options.heartbeatIntervalMs ?? 60 * 60 * 1000;
    this.heartbeatTimer = setInterval(() => this.captureHeartbeat(intervalMs), intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private captureHeartbeat(intervalMs: number): void {
    const stats = this.conversation?.getRuntimeStats() ?? {
      activeTurnCount: 0,
      sideTurnCount: 0,
      queuedMessageCount: 0,
      suspendedTurnCount: 0
    };
    this.telemetry.capture(
      "twinny_heartbeat",
      {
        uptime_ms: Date.now() - this.runtimeStartedAt,
        lark_consumer_running: this.larkConsumer?.isRunning ?? false,
        lark_ready: this.larkConsumer?.isReady ?? false,
        lark_connection_status: safeConnectionStatus(this.larkConsumer?.getConnectionStatus()),
        codex_profile_count: this.codexPool?.listProfiles().length ?? 0,
        active_turn_count: stats.activeTurnCount,
        side_turn_count: stats.sideTurnCount,
        queued_message_count: stats.queuedMessageCount,
        suspended_turn_count: stats.suspendedTurnCount,
        ...memoryUsageTelemetryProperties()
      },
      {
        insertId: `twinny_heartbeat:${this.telemetry.runtimeId}:${Math.floor(Date.now() / intervalMs)}`,
        codexVersion: this.readRuntimeCodexVersion()
      }
    );
  }

  private readRuntimeCodexVersion(): string | null {
    const profile = this.codexPool?.listProfiles()[0];
    return profile ? this.codexPool?.get(profile).readCodexVersion() ?? null : null;
  }

  private async shutdownTelemetry(): Promise<void> {
    try {
      await this.telemetry.shutdown?.();
    } catch (error) {
      this.log.warn({ error }, "failed to shutdown telemetry");
    }
  }
}

export async function createRuntime(config: TwinnyConfig, options: TwinnyRuntimeOptions = {}): Promise<TwinnyRuntime> {
  return new TwinnyRuntime(config, options);
}

function replaceTwinnyConfigContents(target: TwinnyConfig, source: TwinnyConfig): void {
  Object.assign(target, source);
}

function safeConnectionStatus(status: unknown): string | null {
  if (status === undefined || status === null) {
    return null;
  }
  if (typeof status === "string" || typeof status === "number" || typeof status === "boolean") {
    return String(status);
  }
  try {
    return JSON.stringify(status).slice(0, 256);
  } catch {
    return String(status).slice(0, 256);
  }
}

export function adaptConversationRepository(repository: ConversationRepository) {
  return {
    findByConversationKey: (conversationKey: string) => repository.getByConversationKey(conversationKey) ?? null,
    create: repository.create.bind(repository),
    updateThreadBinding: repository.updateThreadBinding.bind(repository),
    updateConversationSettings: repository.updateConversationSettings.bind(repository),
    updateConversationWorkspace: repository.updateConversationWorkspace.bind(repository),
    markThreadHasRollout: repository.markThreadHasRollout.bind(repository),
    getCodexThreadById: repository.getCodexThreadById.bind(repository),
    hasUserMessageForCodexThread: repository.hasUserMessageForCodexThread.bind(repository),
    getCodexThreadByConversationAndLarkThread: repository.getCodexThreadByConversationAndLarkThread.bind(repository),
    listCodexThreadIds: repository.listCodexThreadIds.bind(repository),
    listCodexThreadsByConversation: repository.listCodexThreadsByConversation.bind(repository),
    listCreatedThreadsSinceLatestUserMessage: repository.listCreatedThreadsSinceLatestUserMessage.bind(repository),
    countUnfinishedLarkMessagesByThread: repository.countUnfinishedLarkMessagesByThread.bind(repository),
    getLarkMessageById: repository.getLarkMessageById.bind(repository),
    getLarkMessageByEventId: repository.getLarkMessageByEventId.bind(repository),
    getLarkMessageUsageTargetForTurn: repository.getLarkMessageUsageTargetForTurn.bind(repository),
    getLatestSteeredLarkMessageForTurn: repository.getLatestSteeredLarkMessageForTurn.bind(repository),
    listContiguousSteeredLarkMessagesBefore: repository.listContiguousSteeredLarkMessagesBefore.bind(repository),
    listUnfinishedLarkMessages: repository.listUnfinishedLarkMessages.bind(repository),
    upsertCodexThread: repository.upsertCodexThread.bind(repository),
    replaceCodexThreadForLarkThread: repository.replaceCodexThreadForLarkThread.bind(repository),
    updateCodexThreadTokenUsage: repository.updateCodexThreadTokenUsage.bind(repository),
    updateCodexThreadGoalStatus: repository.updateCodexThreadGoalStatus.bind(repository),
    clearCodexThreadGoalStatus: repository.clearCodexThreadGoalStatus.bind(repository),
    updateCodexThreadCard: repository.updateCodexThreadCard.bind(repository),
    updateCodexThreadModelSettings: repository.updateCodexThreadModelSettings.bind(repository),
    updateCodexThreadWorkspace: repository.updateCodexThreadWorkspace.bind(repository),
    updateCodexThreadName: repository.updateCodexThreadName.bind(repository),
    updateCodexThreadMode: repository.updateCodexThreadMode.bind(repository),
    updateCodexThreadStatus: repository.updateCodexThreadStatus.bind(repository),
    getCodexThreadWorkStats: repository.getCodexThreadWorkStats.bind(repository),
    getCodexThreadStatusStats: repository.getCodexThreadStatusStats.bind(repository),
    getConversationStatusStats: repository.getConversationStatusStats.bind(repository),
    listRecentThreadWorkspaces: repository.listRecentThreadWorkspaces.bind(repository),
    createCronJob: repository.createCronJob.bind(repository),
    listCronJobs: repository.listCronJobs.bind(repository),
    listCronJobsByConversation: repository.listCronJobsByConversation.bind(repository),
    getCronJobByConversationAndId: repository.getCronJobByConversationAndId.bind(repository),
    deleteCronJobByConversationAndId: repository.deleteCronJobByConversationAndId.bind(repository),
    updateCronJobLastRun: repository.updateCronJobLastRun.bind(repository),
    insertLarkMessage: repository.insertLarkMessage.bind(repository),
    hasProcessedDocComment: repository.hasProcessedDocComment.bind(repository),
    markLarkMessageQueued: repository.markLarkMessageQueued.bind(repository),
    markLarkMessageRecalled: repository.markLarkMessageRecalled.bind(repository),
    updateQueuedLarkMessage: repository.updateQueuedLarkMessage.bind(repository),
    updateLarkMessageAgentCardMetadata: repository.updateLarkMessageAgentCardMetadata.bind(repository),
    updateLarkMessageTokenUsage: repository.updateLarkMessageTokenUsage.bind(repository),
    markLarkMessagesProcessing: repository.markLarkMessagesProcessing.bind(repository),
    markLarkMessagesSteered: repository.markLarkMessagesSteered.bind(repository),
    markLarkMessagesCompleted: repository.markLarkMessagesCompleted.bind(repository),
    markLarkMessagesFailed: repository.markLarkMessagesFailed.bind(repository),
    markLarkMessagesInterrupted: repository.markLarkMessagesInterrupted.bind(repository),
    markLarkMessagesCleared: repository.markLarkMessagesCleared.bind(repository),
    upsertLarkDocWatcher: repository.upsertLarkDocWatcher.bind(repository),
    getLarkDocWatcherByFile: repository.getLarkDocWatcherByFile.bind(repository),
    listLarkDocWatchersByThread: repository.listLarkDocWatchersByThread.bind(repository),
    migrateLarkDocWatchersToThread: repository.migrateLarkDocWatchersToThread.bind(repository),
    touchLarkDocWatcherCommentReceived: repository.touchLarkDocWatcherCommentReceived.bind(repository)
  };
}

function adaptCodexPool(pool: ProfileCodexAppServerPool) {
  return {
    startThread: async ({
      profile,
      cwd,
      developerInstructions
    }: {
      profile: ProfileName;
      cwd: string;
      developerInstructions?: string;
    }) => {
      const response = await pool.get(profile).startThread(cwd, { developerInstructions });
      return { threadId: response.thread.id };
    },
    resumeThread: async ({ profile, threadId, cwd }: { profile: ProfileName; threadId: string; cwd: string }) => {
      const response = await pool.get(profile).resumeThread(threadId, cwd);
      return { threadId: response.thread.id };
    },
    forkThread: async ({
      profile,
      threadId,
      cwd,
      ephemeral,
      developerInstructions,
      model,
      effort
    }: {
      profile: ProfileName;
      threadId: string;
      cwd: string;
      ephemeral?: boolean;
      developerInstructions?: string;
      model?: string;
      effort?: string;
    }) => {
      const response = await pool.get(profile).forkThread(threadId, cwd, {
        ephemeral,
        developerInstructions,
        model,
        effort
      });
      return {
        threadId: response.thread.id,
        model: typeof response.model === "string" ? response.model : undefined,
        effort: typeof response.reasoningEffort === "string" ? response.reasoningEffort : undefined,
        cwd: typeof response.cwd === "string" ? response.cwd : undefined
      };
    },
    readThread: async ({
      profile,
      threadId,
      includeTurns
    }: { profile: ProfileName; threadId: string; includeTurns?: boolean }) => {
      const response = await pool.get(profile).readThread(threadId, { includeTurns });
      return response.thread;
    },
    listThreads: async ({ profile, ...params }: { profile: ProfileName } & ThreadListParams) => {
      return pool.get(profile).listThreads(params);
    },
    injectThreadItems: async ({ profile, threadId, items }: { profile: ProfileName; threadId: string; items: unknown[] }) => {
      await pool.get(profile).injectThreadItems(threadId, items);
    },
    unsubscribeThread: async ({ profile, threadId }: { profile: ProfileName; threadId: string }) => {
      await pool.get(profile).unsubscribeThread(threadId);
    },
    startTurn: async ({
      profile,
      threadId,
      input,
      currentThreadName,
      cwd,
      mode,
      model,
      effort,
      onTurnStarted,
      onAgentMessage,
      onImageGeneration,
      onCodexError,
      onTokenUsage,
      onPlanUpdated,
      onRequestUserInput,
      onSetThreadName,
      onDynamicToolCall
    }: {
      profile: ProfileName;
      threadId: string;
      input: CodexTurnInput;
      currentThreadName?: string;
      cwd: string;
      mode?: CodexThreadMode;
      model?: string;
      effort?: string;
      onTurnStarted?: (turnId: string) => Promise<void> | void;
      onAgentMessage?: (message: CodexAgentMessage) => Promise<void> | void;
      onImageGeneration?: (image: CodexImageGeneration) => Promise<void> | void;
      onCodexError?: (error: CodexErrorNotification) => Promise<void> | void;
      onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
      onPlanUpdated?: (plan: CodexPlanUpdate) => Promise<void> | void;
      onRequestUserInput?: (
        request: CodexRequestUserInputRequest,
        responder: CodexRequestUserInputResponder
      ) => Promise<void> | void;
      onSetThreadName?: (request: CodexSetThreadNameToolRequest) => Promise<CodexDynamicToolCallResponse> | CodexDynamicToolCallResponse;
      onDynamicToolCall?: (request: CodexTwinnyDynamicToolRequest) => Promise<CodexDynamicToolCallResponse> | CodexDynamicToolCallResponse;
    }) =>
      pool.get(profile).startTurn({
        threadId,
        ...(typeof input === "string" ? { text: input } : { input }),
        currentThreadName,
        cwd,
        mode,
        model,
        effort,
        onTurnStarted,
        onAgentMessage,
        onImageGeneration,
        onCodexError,
        onTokenUsage,
        onPlanUpdated,
        onRequestUserInput,
        onSetThreadName,
        onDynamicToolCall
      }),
    compactThread: async ({
      profile,
      threadId,
      cwd,
      onTurnStarted,
      onTokenUsage
    }: {
      profile: ProfileName;
      threadId: string;
      cwd: string;
      onTurnStarted?: (turnId: string) => Promise<void> | void;
      onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
    }) =>
      pool.get(profile).compactThread({
        threadId,
        cwd,
        onTurnStarted,
        onTokenUsage
      }),
    setThreadGoal: async ({
      profile,
      threadId,
      objective
    }: {
      profile: ProfileName;
      threadId: string;
      objective: string;
    }) => pool.get(profile).setThreadGoal(threadId, objective),
    getThreadGoal: async ({
      profile,
      threadId
    }: {
      profile: ProfileName;
      threadId: string;
    }) => pool.get(profile).getThreadGoal(threadId),
    clearThreadGoal: async ({
      profile,
      threadId
    }: {
      profile: ProfileName;
      threadId: string;
    }): Promise<void> => {
      await pool.get(profile).clearThreadGoal(threadId);
    },
    setThreadName: async ({
      profile,
      threadId,
      name
    }: {
      profile: ProfileName;
      threadId: string;
      name: string;
    }): Promise<void> => {
      await pool.get(profile).setThreadName(threadId, name);
    },
    readThreadMetadata: async ({
      profile,
      threadId
    }: {
      profile: ProfileName;
      threadId: string;
    }) => pool.get(profile).readThreadMetadata(threadId),
    runGoal: async ({
      profile,
      ...options
    }: Parameters<NonNullable<CodexBridge["runGoal"]>>[0]) => pool.get(profile).runGoal(options),
    resumeGoal: async ({
      profile,
      ...options
    }: Parameters<NonNullable<CodexBridge["resumeGoal"]>>[0]) => pool.get(profile).resumeGoal(options),
    steerTurn: async ({
      profile,
      threadId,
      turnId,
      input,
      cwd
    }: {
      profile: ProfileName;
      threadId: string;
      turnId: string;
      input: CodexTurnInput;
      cwd: string;
    }): Promise<void> => {
      await pool.get(profile).steerTurn({
        threadId,
        turnId,
        cwd,
        ...(typeof input === "string" ? { text: input } : { input })
      });
    },
    interruptTurn: async ({
      profile,
      threadId,
      turnId
    }: {
      profile: ProfileName;
      threadId: string;
      turnId: string;
    }): Promise<void> => {
      await pool.get(profile).interruptTurn({ threadId, turnId });
    },
    readCodexVersion: ({ profile }: { profile: ProfileName }): string => {
      return pool.get(profile).readCodexVersion();
    },
    readAccountRateLimits: async ({ profile }: { profile: ProfileName }): Promise<unknown> => {
      return pool.get(profile).readAccountRateLimits();
    }
  };
}

function adaptLarkSender(
  sender: LarkMessageSender,
  workingReaction: string,
  completedReaction: string,
  queuedReaction: string
) {
  return {
    addTypingReaction: (messageId: string): Promise<LarkReactionHandle | null> => sender.createReaction(messageId, workingReaction),
    addCompletedReaction: (messageId: string): Promise<LarkReactionHandle | null> =>
      sender.createReaction(messageId, completedReaction),
    addQueuedReaction: (messageId: string): Promise<LarkReactionHandle | null> => sender.createReaction(messageId, queuedReaction),
    removeReaction: (handle: LarkReactionHandle): Promise<void> => sender.deleteReaction(handle),
    replyText: async (
      messageId: string,
      text: string,
      options?: { replyInThread?: boolean; uuid?: string }
    ): Promise<{ messageId?: string; raw?: unknown }> => {
      return sender.replyText(messageId, text, options);
    },
    replyMarkdown: async (
      messageId: string,
      markdown: string,
      options?: { replyInThread?: boolean }
    ): Promise<{ messageId?: string; raw?: unknown }> => {
      return sender.replyMarkdown(messageId, markdown, options);
    },
    replyPost: async (
      messageId: string,
      content: Parameters<LarkMessageSender["replyPost"]>[1],
      options?: { replyInThread?: boolean }
    ): Promise<{ messageId?: string; raw?: unknown }> => {
      return sender.replyPost(messageId, content, options);
    },
    replyFile: async (messageId: string, fileKey: string): Promise<{ messageId?: string }> => {
      return sender.replyFile(messageId, fileKey);
    },
    replyImage: async (messageId: string, imageKey: string): Promise<{ messageId?: string }> => {
      return sender.replyImage(messageId, imageKey);
    },
    sendTextToOpenId: async (openId: string, text: string, options?: { uuid?: string }) => {
      return sender.sendTextToOpenId(openId, text, options);
    },
    sendTextToChatId: async (chatId: string, text: string, options?: { uuid?: string }) => {
      return sender.sendTextToChatId(chatId, text, options);
    },
    sendPostToOpenId: async (openId: string, content: Parameters<LarkMessageSender["sendPostToOpenId"]>[1]) => {
      return sender.sendPostToOpenId(openId, content);
    },
    sendPostToChatId: async (chatId: string, content: Parameters<LarkMessageSender["sendPostToChatId"]>[1]) => {
      return sender.sendPostToChatId(chatId, content);
    },
    sendCardToOpenId: async (
      openId: string,
      card: Parameters<LarkMessageSender["sendInteractiveCardToOpenId"]>[1],
      options?: { uuid?: string }
    ) => {
      return sender.sendInteractiveCardToOpenId(openId, card, options);
    },
    sendCardToChatId: async (
      chatId: string,
      card: Parameters<LarkMessageSender["sendInteractiveCardToChatId"]>[1],
      options?: { uuid?: string }
    ) => {
      return sender.sendInteractiveCardToChatId(chatId, card, options);
    },
    sendEphemeralCardToChatId: async (
      chatId: string,
      openId: string,
      card: Parameters<LarkMessageSender["sendEphemeralInteractiveCardToChatId"]>[2]
    ) => {
      return sender.sendEphemeralInteractiveCardToChatId(chatId, openId, card);
    },
    forwardThreadToThread: async (
      threadId: string,
      receiveThreadId: string,
      options?: { uuid?: string }
    ) => {
      return sender.forwardThreadToThread(threadId, receiveThreadId, options);
    },
    forwardThread: async (
      threadId: string,
      receiveId: string,
      receiveIdType: "thread_id" | "chat_id",
      options?: { uuid?: string }
    ) => {
      return sender.forwardThread(threadId, receiveId, receiveIdType, options);
    },
    replyCard: async (
      messageId: string,
      card: Parameters<LarkMessageSender["replyInteractiveCard"]>[1],
      options?: { replyInThread?: boolean }
    ): Promise<{ messageId?: string; raw?: unknown }> => {
      return sender.replyInteractiveCard(messageId, card, options);
    },
    patchCard: async (messageId: string, card: Parameters<LarkMessageSender["patchInteractiveCard"]>[1]): Promise<{ messageId?: string }> => {
      return sender.patchInteractiveCard(messageId, card);
    },
    recallMessage: async (messageId: string): Promise<void> => {
      await sender.deleteMessage(messageId);
    },
    deleteEphemeralMessage: async (messageId: string): Promise<void> => {
      await sender.deleteEphemeralMessage(messageId);
    },
    getMessageReadOpenIds: async (messageId: string): Promise<string[]> => {
      return sender.listMessageReadOpenIds(messageId);
    }
  };
}
