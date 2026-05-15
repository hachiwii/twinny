import type { Logger } from "pino";
import { createRuntimePaths, resolveSecretRef, SecurityCliSecretStore } from "../config/index.js";
import { RoleCodexAppServerPool } from "../codex/index.js";
import { ConversationManager } from "../conversation/manager.js";
import {
  LarkEventConsumer,
  LarkMessageSender,
  LarkOpenApiClient,
  TenantAccessTokenManager
} from "../lark/index.js";
import { acquireTwinnyLock, type TwinnyRuntimeLock } from "../lock/index.js";
import { logger as defaultLogger } from "../observability/logs.js";
import { TwinnySystemNotifier } from "../observability/system-notifications.js";
import { getRoleCodexHome } from "../roles/index.js";
import { createConversationRepository, openRuntimeDatabase, type ConversationRepository, type TwinnyDatabase } from "../store/index.js";
import type { LarkReactionHandle, RoleName, TwinnyConfig } from "../types.js";
import { WorkspaceManager } from "../workspace/index.js";

export interface TwinnyRuntimeOptions {
  logger?: Logger;
  requestTimeoutMs?: number;
}

export class TwinnyRuntime {
  private readonly log: Logger;
  private readonly paths;
  private readonly secretStore = new SecurityCliSecretStore();
  private lock?: TwinnyRuntimeLock;
  private db?: TwinnyDatabase;
  private codexPool?: RoleCodexAppServerPool;
  private larkConsumer?: LarkEventConsumer;
  private systemNotifier?: TwinnySystemNotifier;
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
    this.lock = await acquireTwinnyLock(this.paths, { stale: 30_000, update: 10_000 });
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
      this.codexPool.get(role).on("exit", (code, signal) => {
        this.log.error({ role, code, signal }, "codex app-server exited");
      });
    }
    await this.codexPool.startAll();

    const tokenManager = new TenantAccessTokenManager({
      appId: this.config.lark.appId,
      appSecret
    });
    const openApiClient = new LarkOpenApiClient({ tokenManager });
    const larkSender = new LarkMessageSender({ openApiClient, logger: this.log });
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
      lark: adaptLarkSender(larkSender, this.config.lark.workingReaction),
      roles: { codexHomeFor: (role) => getRoleCodexHome(this.config, role) },
      logger: this.log
    });

    this.larkConsumer = new LarkEventConsumer({
      appId: this.config.lark.appId,
      appSecret,
      logger: this.log,
      onMessage: (message) => conversation.handleIncoming(message),
      onIgnored: (reason) => this.log.debug({ reason }, "lark event ignored")
    });
    await this.larkConsumer.start();
    await this.systemNotifier.notifyInitialized({ home: this.config.home, appId: this.config.lark.appId });
    this.log.info({ home: this.config.home }, "twinny daemon started");
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.log.info({ signal }, "stopping twinny daemon");
    try {
      await this.systemNotifier?.notifyGracefulExit({ signal });
      await this.stopLarkConsumer();
      await this.stopCodexPool(signal);
      this.closeDatabase();
    } finally {
      await this.releaseLock();
      this.resolveStopped();
    }
  }

  async wait(): Promise<void> {
    await this.stopPromise;
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
}

export async function createRuntime(config: TwinnyConfig, options: TwinnyRuntimeOptions = {}): Promise<TwinnyRuntime> {
  return new TwinnyRuntime(config, options);
}

function adaptConversationRepository(repository: ConversationRepository) {
  return {
    findByConversationKey: (conversationKey: string) => repository.getByConversationKey(conversationKey) ?? null,
    create: repository.create.bind(repository),
    updateThreadBinding: repository.updateThreadBinding.bind(repository)
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
    startTurn: async ({
      role,
      threadId,
      input,
      cwd,
      onTurnStarted,
      onAgentMessage
    }: {
      role: RoleName;
      threadId: string;
      input: string;
      cwd: string;
      onTurnStarted?: (turnId: string) => Promise<void> | void;
      onAgentMessage?: (message: { id: string; text: string }) => Promise<void> | void;
    }) =>
      pool.get(role).startTurn({
        threadId,
        text: input,
        cwd,
        onTurnStarted,
        onAgentMessage
      }),
    steerTurn: async ({
      role,
      threadId,
      turnId,
      input
    }: {
      role: RoleName;
      threadId: string;
      turnId: string;
      input: string;
    }): Promise<void> => {
      await pool.get(role).steerTurn({ threadId, turnId, text: input });
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
    }
  };
}

function adaptLarkSender(sender: LarkMessageSender, workingReaction: string) {
  return {
    addTypingReaction: (messageId: string): Promise<LarkReactionHandle | null> => sender.createReaction(messageId, workingReaction),
    removeReaction: (handle: LarkReactionHandle): Promise<void> => sender.deleteReaction(handle),
    replyText: async (messageId: string, text: string): Promise<void> => {
      await sender.replyText(messageId, text);
    }
  };
}
