import type { Logger } from "pino";
import {
  createRuntimePaths,
  resolveBundledBannerPath,
  resolveBundledLogoPath,
  resolveSecretRef,
  SecurityCliSecretStore
} from "../config/index.js";
import { RoleCodexAppServerPool } from "../codex/index.js";
import { ConversationManager, type CodexBridge } from "../conversation/manager.js";
import {
  LarkEventConsumer,
  LarkFileDownloader,
  LarkMessageReader,
  LarkMessageSender,
  LarkBotDirectory,
  LarkChatDirectory,
  LarkUserDirectory,
  LarkOpenApiClient,
  TenantAccessTokenManager
} from "../lark/index.js";
import { acquireTwinnyLock, type TwinnyRuntimeLock } from "../lock/index.js";
import { logger as defaultLogger } from "../observability/logs.js";
import { TwinnySystemNotifier } from "../observability/system-notifications.js";
import { getRoleCodexHome } from "../roles/index.js";
import { createConversationRepository, openRuntimeDatabase, type ConversationRepository, type TwinnyDatabase } from "../store/index.js";
import type {
  CodexAgentMessage,
  CodexImageGeneration,
  CodexPlanUpdate,
  CodexRequestUserInputRequest,
  CodexThreadMode,
  CodexThreadTokenUsageUpdate,
  LarkReactionHandle,
  RoleName,
  TwinnyConfig
} from "../types.js";
import type {
  CodexDynamicToolCallResponse,
  CodexRequestUserInputResponder,
  CodexSetThreadNameToolRequest,
  CodexTurnInput
} from "../codex/turn.js";
import { WorkspaceManager } from "../workspace/index.js";
import { MacIdleSleepPreventer, type IdleSleepPreventer } from "./caffeinate.js";
import {
  provisionLarkAssetImageKeys as provisionRuntimeLarkAssetImageKeys,
  type LarkAssetImageKeys
} from "./lark-assets.js";

export interface TwinnyRuntimeOptions {
  logger?: Logger;
  requestTimeoutMs?: number;
  logoFilePath?: string;
  bannerFilePath?: string;
  idleSleepPreventer?: IdleSleepPreventer;
}

export class TwinnyRuntime {
  private readonly log: Logger;
  private readonly paths;
  private readonly secretStore = new SecurityCliSecretStore();
  private lock?: TwinnyRuntimeLock;
  private db?: TwinnyDatabase;
  private codexPool?: RoleCodexAppServerPool;
  private idleSleepPreventer?: IdleSleepPreventer;
  private larkConsumer?: LarkEventConsumer;
  private conversation?: ConversationManager;
  private systemNotifier?: TwinnySystemNotifier;
  private readonly codexRecoveryByRole = new Map<RoleName, Promise<void>>();
  private stopped = false;
  private stopPromise: Promise<void>;
  private resolveStopped!: () => void;

  constructor(
    private readonly config: TwinnyConfig,
    private readonly options: TwinnyRuntimeOptions = {}
  ) {
    this.log = options.logger ?? defaultLogger;
    this.paths = createRuntimePaths(config.home);
    this.stopPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  async start(): Promise<void> {
    try {
      this.lock = await acquireTwinnyLock(this.paths, { stale: 30_000, update: 10_000 });
      this.idleSleepPreventer = this.options.idleSleepPreventer ?? new MacIdleSleepPreventer({ logger: this.log });
      this.idleSleepPreventer.start();
      this.db = openRuntimeDatabase(this.paths);

      const appSecret = await resolveSecretRef(this.config.lark.appSecretRef, this.secretStore);
      if (!appSecret) {
        throw new Error(`Lark app secret is missing: ${this.config.lark.appSecretRef}`);
      }
      this.codexPool = new RoleCodexAppServerPool({
        binary: this.config.codex.binary,
        roles: this.config.roles,
        requestTimeoutMs: this.options.requestTimeoutMs ?? 10 * 60 * 1000
      });
      for (const role of ["owner", "guest"] as RoleName[]) {
        this.codexPool.get(role).on("stderr", (chunk) => {
          this.log.debug({ role, stream: "stderr", chunk }, "codex app-server stderr");
        });
        this.codexPool.get(role).on("threadNameUpdated", (update) => {
          this.conversation?.submitCodexThreadNameUpdated(update);
        });
        this.codexPool.get(role).on("exit", (code, signal) => {
          this.log.error({ role, code, signal }, "codex app-server exited");
          void this.handleCodexAppServerExit(role).catch((error) => {
            this.log.error({ error, role }, "failed to recover codex app-server after exit");
          });
        });
      }
      await this.codexPool.startAll();

      const tokenManager = new TenantAccessTokenManager({
        appId: this.config.lark.appId,
        appSecret
      });
      const openApiClient = new LarkOpenApiClient({ tokenManager });
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
      const assetImageKeys = await this.provisionLarkAssetImageKeys(larkFiles);
      const systemNotifier = new TwinnySystemNotifier({
        ownerOpenId: this.config.owner.openId,
        sender: larkSender,
        logger: this.log
      });
      this.systemNotifier = systemNotifier;
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
        botOpenId,
        assetImageKeys,
        roles: { codexHomeFor: (role) => getRoleCodexHome(this.config, role) },
        logger: this.log
      });
      this.conversation = conversation;
      await conversation.recoverUnfinishedMessages();

      this.larkConsumer = new LarkEventConsumer({
        appId: this.config.lark.appId,
        appSecret,
        botOpenId,
        logger: this.log,
        maxMessageAgeMs: this.config.lark.maxMessageAgeSeconds * 1000,
        onMessage: (message) => {
          conversation.submitIncoming(message);
        },
        onMessageRecall: (recall) => {
          conversation.submitMessageRecall(recall);
        },
        onBotMenu: (action) => {
          conversation.submitBotMenuAction(action);
        },
        onCardAction: (action) => {
          conversation.submitCardAction(action);
        },
        onIgnored: (reason) => this.log.debug({ reason }, "lark event ignored")
      });
      await this.larkConsumer.start();
      await this.systemNotifier.notifyInitialized({ bannerImageKey: assetImageKeys.bannerImageKey });
      this.log.info({ home: this.config.home }, "twinny daemon started");
    } catch (error) {
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
      await this.shutdownConversation();
      await this.stopLarkConsumer();
      await this.stopCodexPool(signal);
      this.closeDatabase();
    } finally {
      await this.releaseLock();
      await this.stopIdleSleepPreventer(signal);
      this.resolveStopped();
    }
  }

  async wait(): Promise<void> {
    await this.stopPromise;
  }

  private async handleCodexAppServerExit(role: RoleName): Promise<void> {
    if (this.stopped) {
      return;
    }
    const existing = this.codexRecoveryByRole.get(role);
    if (existing) {
      return existing;
    }
    const recovery = this.recoverCodexAppServer(role).finally(() => {
      if (this.codexRecoveryByRole.get(role) === recovery) {
        this.codexRecoveryByRole.delete(role);
      }
    });
    this.codexRecoveryByRole.set(role, recovery);
    await recovery;
  }

  private async recoverCodexAppServer(role: RoleName): Promise<void> {
    const pool = this.codexPool;
    if (!pool || this.stopped) {
      return;
    }
    const suspended = (await this.conversation?.suspendActiveTurnsForCodexAppServerExit(role)) ?? 0;
    this.log.warn({ role, suspended }, "recovering codex app-server after exit");
    await pool.restart(role);
    if (this.stopped) {
      return;
    }
    const recovered = (await this.conversation?.recoverSuspendedActiveTurnsForCodexAppServerExit(role)) ?? 0;
    this.log.info({ role, suspended, recovered }, "codex app-server recovered after exit");
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
    try {
      await pool.stopAll(signal);
    } catch (error) {
      this.log.warn({ error }, "failed to stop codex app-server pool cleanly");
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
}

export async function createRuntime(config: TwinnyConfig, options: TwinnyRuntimeOptions = {}): Promise<TwinnyRuntime> {
  return new TwinnyRuntime(config, options);
}

export function adaptConversationRepository(repository: ConversationRepository) {
  return {
    findByConversationKey: (conversationKey: string) => repository.getByConversationKey(conversationKey) ?? null,
    create: repository.create.bind(repository),
    updateThreadBinding: repository.updateThreadBinding.bind(repository),
    updateConversationSettings: repository.updateConversationSettings.bind(repository),
    markThreadHasRollout: repository.markThreadHasRollout.bind(repository),
    getCodexThreadById: repository.getCodexThreadById.bind(repository),
    getCodexThreadByConversationAndLarkThread: repository.getCodexThreadByConversationAndLarkThread.bind(repository),
    getLarkMessageById: repository.getLarkMessageById.bind(repository),
    getLarkMessageByEventId: repository.getLarkMessageByEventId.bind(repository),
    getLarkMessageUsageTargetForTurn: repository.getLarkMessageUsageTargetForTurn.bind(repository),
    getLatestSteeredLarkMessageForTurn: repository.getLatestSteeredLarkMessageForTurn.bind(repository),
    listUnfinishedLarkMessages: repository.listUnfinishedLarkMessages.bind(repository),
    upsertCodexThread: repository.upsertCodexThread.bind(repository),
    replaceCodexThreadForLarkThread: repository.replaceCodexThreadForLarkThread.bind(repository),
    updateCodexThreadTokenUsage: repository.updateCodexThreadTokenUsage.bind(repository),
    updateCodexThreadGoalStatus: repository.updateCodexThreadGoalStatus.bind(repository),
    clearCodexThreadGoalStatus: repository.clearCodexThreadGoalStatus.bind(repository),
    updateCodexThreadCard: repository.updateCodexThreadCard.bind(repository),
    updateCodexThreadName: repository.updateCodexThreadName.bind(repository),
    updateCodexThreadMode: repository.updateCodexThreadMode.bind(repository),
    updateCodexThreadStatus: repository.updateCodexThreadStatus.bind(repository),
    getCodexThreadWorkStats: repository.getCodexThreadWorkStats.bind(repository),
    getCodexThreadStatusStats: repository.getCodexThreadStatusStats.bind(repository),
    getConversationStatusStats: repository.getConversationStatusStats.bind(repository),
    insertLarkMessage: repository.insertLarkMessage.bind(repository),
    markLarkMessageQueued: repository.markLarkMessageQueued.bind(repository),
    markLarkMessageRecalled: repository.markLarkMessageRecalled.bind(repository),
    updateQueuedLarkMessage: repository.updateQueuedLarkMessage.bind(repository),
    updateLarkMessageSideMetadata: repository.updateLarkMessageSideMetadata.bind(repository),
    updateLarkMessageTokenUsage: repository.updateLarkMessageTokenUsage.bind(repository),
    markLarkMessagesProcessing: repository.markLarkMessagesProcessing.bind(repository),
    markLarkMessagesSteered: repository.markLarkMessagesSteered.bind(repository),
    markLarkMessagesCompleted: repository.markLarkMessagesCompleted.bind(repository),
    markLarkMessagesFailed: repository.markLarkMessagesFailed.bind(repository),
    markLarkMessagesInterrupted: repository.markLarkMessagesInterrupted.bind(repository),
    markLarkMessagesCleared: repository.markLarkMessagesCleared.bind(repository)
  };
}

function adaptCodexPool(pool: RoleCodexAppServerPool) {
  return {
    startThread: async ({ role, cwd }: { role: RoleName; cwd: string }) => {
      const response = await pool.get(role).startThread(cwd);
      return { threadId: response.thread.id };
    },
    resumeThread: async ({ role, threadId, cwd }: { role: RoleName; threadId: string; cwd: string }) => {
      const response = await pool.get(role).resumeThread(threadId, cwd);
      return { threadId: response.thread.id };
    },
    forkThread: async ({
      role,
      threadId,
      cwd,
      ephemeral,
      developerInstructions,
      model,
      effort
    }: {
      role: RoleName;
      threadId: string;
      cwd: string;
      ephemeral?: boolean;
      developerInstructions?: string;
      model?: string;
      effort?: string;
    }) => {
      const response = await pool.get(role).forkThread(threadId, cwd, {
        ephemeral,
        developerInstructions,
        model,
        effort
      });
      return { threadId: response.thread.id };
    },
    injectThreadItems: async ({ role, threadId, items }: { role: RoleName; threadId: string; items: unknown[] }) => {
      await pool.get(role).injectThreadItems(threadId, items);
    },
    unsubscribeThread: async ({ role, threadId }: { role: RoleName; threadId: string }) => {
      await pool.get(role).unsubscribeThread(threadId);
    },
    startTurn: async ({
      role,
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
      onTokenUsage,
      onPlanUpdated,
      onRequestUserInput,
      onSetThreadName
    }: {
      role: RoleName;
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
      onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
      onPlanUpdated?: (plan: CodexPlanUpdate) => Promise<void> | void;
      onRequestUserInput?: (
        request: CodexRequestUserInputRequest,
        responder: CodexRequestUserInputResponder
      ) => Promise<void> | void;
      onSetThreadName?: (request: CodexSetThreadNameToolRequest) => Promise<CodexDynamicToolCallResponse> | CodexDynamicToolCallResponse;
    }) =>
      pool.get(role).startTurn({
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
        onTokenUsage,
        onPlanUpdated,
        onRequestUserInput,
        onSetThreadName
      }),
    compactThread: async ({
      role,
      threadId,
      cwd,
      onTurnStarted,
      onTokenUsage
    }: {
      role: RoleName;
      threadId: string;
      cwd: string;
      onTurnStarted?: (turnId: string) => Promise<void> | void;
      onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
    }) =>
      pool.get(role).compactThread({
        threadId,
        cwd,
        onTurnStarted,
        onTokenUsage
      }),
    setThreadGoal: async ({
      role,
      threadId,
      objective
    }: {
      role: RoleName;
      threadId: string;
      objective: string;
    }) => pool.get(role).setThreadGoal(threadId, objective),
    getThreadGoal: async ({
      role,
      threadId
    }: {
      role: RoleName;
      threadId: string;
    }) => pool.get(role).getThreadGoal(threadId),
    clearThreadGoal: async ({
      role,
      threadId
    }: {
      role: RoleName;
      threadId: string;
    }): Promise<void> => {
      await pool.get(role).clearThreadGoal(threadId);
    },
    setThreadName: async ({
      role,
      threadId,
      name
    }: {
      role: RoleName;
      threadId: string;
      name: string;
    }): Promise<void> => {
      await pool.get(role).setThreadName(threadId, name);
    },
    runGoal: async ({
      role,
      ...options
    }: Parameters<NonNullable<CodexBridge["runGoal"]>>[0]) => pool.get(role).runGoal(options),
    resumeGoal: async ({
      role,
      ...options
    }: Parameters<NonNullable<CodexBridge["resumeGoal"]>>[0]) => pool.get(role).resumeGoal(options),
    steerTurn: async ({
      role,
      threadId,
      turnId,
      input
    }: {
      role: RoleName;
      threadId: string;
      turnId: string;
      input: CodexTurnInput;
    }): Promise<void> => {
      await pool.get(role).steerTurn({
        threadId,
        turnId,
        ...(typeof input === "string" ? { text: input } : { input })
      });
    },
    interruptTurn: async ({
      role,
      threadId,
      turnId
    }: {
      role: RoleName;
      threadId: string;
      turnId: string;
    }): Promise<void> => {
      await pool.get(role).interruptTurn({ threadId, turnId });
    },
    readCodexVersion: ({ role }: { role: RoleName }): string => {
      return pool.get(role).readCodexVersion();
    },
    readAccountRateLimits: async ({ role }: { role: RoleName }): Promise<unknown> => {
      return pool.get(role).readAccountRateLimits();
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
      options?: { replyInThread?: boolean }
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
    sendTextToOpenId: async (openId: string, text: string): Promise<void> => {
      await sender.sendTextToOpenId(openId, text);
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
    getMessageReadOpenIds: async (messageId: string): Promise<string[]> => {
      return sender.listMessageReadOpenIds(messageId);
    }
  };
}
