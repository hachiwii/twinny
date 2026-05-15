import type { Logger } from "pino";
import { createRuntimePaths, resolveSecretRef, secretAccountFromRef, SecurityCliSecretStore } from "../config/index.js";
import { RoleCodexAppServerPool } from "../codex/index.js";
import { ConversationManager } from "../conversation/manager.js";
import {
  LarkApprovalClient,
  LarkAutoApprovalWorker,
  LarkEventConsumer,
  LarkMessageSender,
  LarkOpenApiClient,
  TenantAccessTokenManager,
  UserAccessTokenManager,
  type UserAccessTokenResult
} from "../lark/index.js";
import { acquireTwinnyLock, type TwinnyRuntimeLock } from "../lock/index.js";
import { logger as defaultLogger } from "../observability/logs.js";
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
  private autoApprovalWorker?: LarkAutoApprovalWorker;
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
    const autoApprovalWorker = await this.createAutoApprovalWorker(appSecret);

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
    const repository = createConversationRepository(this.db);
    const workspaceManager = WorkspaceManager.fromRuntimePaths(this.paths);
    const conversation = new ConversationManager({
      config: this.config,
      repository: adaptConversationRepository(repository),
      workspaces: workspaceManager,
      codex: adaptCodexPool(this.codexPool),
      lark: adaptLarkSender(larkSender),
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
    this.autoApprovalWorker = autoApprovalWorker;
    this.autoApprovalWorker?.start();
    this.log.info({ home: this.config.home }, "twinny daemon started");
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.log.info({ signal }, "stopping twinny daemon");
    try {
      await this.stopAutoApprovalWorker();
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

  private async createAutoApprovalWorker(appSecret: string): Promise<LarkAutoApprovalWorker | undefined> {
    if (!this.config.autoApproval.enabled) {
      return undefined;
    }
    const definitionCode = this.config.autoApproval.definitionCode;
    if (!definitionCode) {
      throw new Error("auto_approval.definition_code is required when auto approval is enabled");
    }
    if (!this.config.owner.tokenRef) {
      throw new Error("owner.token_ref is required when auto approval is enabled");
    }
    if (!this.config.owner.refreshTokenRef) {
      throw new Error("owner.refresh_token_ref is required when auto approval is enabled");
    }

    const [ownerAccessToken, ownerRefreshToken] = await Promise.all([
      resolveSecretRef(this.config.owner.tokenRef, this.secretStore),
      resolveSecretRef(this.config.owner.refreshTokenRef, this.secretStore)
    ]);
    if (!ownerAccessToken) {
      throw new Error(`Lark owner user token is missing: ${this.config.owner.tokenRef}`);
    }
    if (!ownerRefreshToken) {
      throw new Error(`Lark owner refresh token is missing: ${this.config.owner.refreshTokenRef}`);
    }

    let refreshedToken: UserAccessTokenResult | undefined;
    const userTokenManager = new UserAccessTokenManager({
      appId: this.config.lark.appId,
      appSecret,
      accessToken: ownerAccessToken,
      refreshToken: ownerRefreshToken,
      onTokenRefresh: async (token) => {
        refreshedToken = token;
        await this.secretStore.set(secretAccountFromRef(this.config.owner.tokenRef!), token.accessToken);
        if (token.refreshToken && this.config.owner.refreshTokenRef) {
          await this.secretStore.set(secretAccountFromRef(this.config.owner.refreshTokenRef), token.refreshToken);
        }
      }
    });
    await userTokenManager.getAccessToken({ forceRefresh: true });
    assertAutoApprovalScopes(refreshedToken?.scope ?? "");

    const userOpenApiClient = new LarkOpenApiClient({
      accessTokenProvider: {
        getAccessToken: () => userTokenManager.getAccessToken()
      }
    });
    return new LarkAutoApprovalWorker({
      approvalClient: new LarkApprovalClient({ openApiClient: userOpenApiClient, logger: this.log }),
      appId: this.config.lark.appId,
      definitionCode,
      pollIntervalMs: this.config.autoApproval.pollIntervalMs,
      logger: this.log
    });
  }

  private async stopAutoApprovalWorker(): Promise<void> {
    if (!this.autoApprovalWorker) {
      return;
    }
    const worker = this.autoApprovalWorker;
    this.autoApprovalWorker = undefined;
    try {
      await worker.stop();
    } catch (error) {
      this.log.warn({ error }, "failed to stop Lark auto-approval worker cleanly");
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
}

export async function createRuntime(config: TwinnyConfig, options: TwinnyRuntimeOptions = {}): Promise<TwinnyRuntime> {
  return new TwinnyRuntime(config, options);
}

function assertAutoApprovalScopes(scope: string): void {
  const scopes = new Set(scope.split(/\s+/).filter(Boolean));
  const missing: string[] = [];
  if (!hasAnyScope(scopes, ["approval:task:read", "approval:approval:readonly", "approval:approval"])) {
    missing.push("approval:task:read");
  }
  if (!hasAnyScope(scopes, ["approval:instance:read", "approval:approval:readonly", "approval:approval", "approval:instance"])) {
    missing.push("approval:instance:read");
  }
  if (!hasAnyScope(scopes, ["approval:task:write", "approval:task", "approval:approval"])) {
    missing.push("approval:task:write");
  }
  if (missing.length > 0) {
    throw new Error(
      `Lark owner authorization is missing approval scopes: ${missing.join(", ")}. Re-authorize the owner with approval scopes.`
    );
  }
}

function hasAnyScope(actual: Set<string>, allowed: string[]): boolean {
  return allowed.some((scope) => actual.has(scope));
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
      onAgentMessage
    }: {
      role: RoleName;
      threadId: string;
      input: string;
      cwd: string;
      onAgentMessage?: (message: { id: string; text: string }) => Promise<void> | void;
    }) =>
      pool.get(role).startTurn({
        threadId,
        text: input,
        cwd,
        onAgentMessage
      })
  };
}

function adaptLarkSender(sender: LarkMessageSender) {
  return {
    addTypingReaction: (messageId: string): Promise<LarkReactionHandle | null> => sender.createTypingReaction(messageId),
    removeReaction: (handle: LarkReactionHandle): Promise<void> => sender.deleteTypingReaction(handle),
    replyText: async (messageId: string, text: string): Promise<void> => {
      await sender.replyText(messageId, text);
    }
  };
}
