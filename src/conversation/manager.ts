import { LRUCache } from "lru-cache";
import type { Logger } from "pino";
import { toErrorMessage } from "../errors.js";
import { logger as defaultLogger } from "../observability/logs.js";
import type {
  CodexTurnResult,
  ConversationRecord,
  IncomingLarkMessage,
  LarkReactionHandle,
  NewConversationRecord,
  RoleName,
  TwinnyConfig
} from "../types.js";
import { conversationKeyForP2p, conversationTypeForChat, roleForSender } from "./routing.js";
import { SerialQueue } from "./queue.js";

export interface ConversationRepository {
  findByConversationKey(conversationKey: string): Promise<ConversationRecord | null> | ConversationRecord | null;
  create(record: NewConversationRecord): Promise<ConversationRecord> | ConversationRecord;
  updateThreadBinding(
    conversationKey: string,
    update: { codexThreadId: string; role?: RoleName; roleCodexHome?: string; workspace?: string }
  ): Promise<ConversationRecord> | ConversationRecord;
}

export interface WorkspaceManagerLike {
  ensureWorkspace(conversationKey: string): Promise<string> | string;
}

export interface CodexBridge {
  startThread(params: {
    role: RoleName;
    cwd: string;
    approvalPolicy: "never";
  }): Promise<{ threadId: string }>;
  resumeThread(params: {
    role: RoleName;
    threadId: string;
    cwd: string;
    approvalPolicy: "never";
  }): Promise<{ threadId: string }>;
  startTurn(params: {
    role: RoleName;
    threadId: string;
    input: string;
    cwd: string;
    approvalPolicy: "never";
    onAgentMessage?: (message: { id: string; text: string }) => Promise<void> | void;
  }): Promise<CodexTurnResult>;
}

export interface LarkResponder {
  addTypingReaction(messageId: string): Promise<LarkReactionHandle | null>;
  removeReaction(handle: LarkReactionHandle): Promise<void>;
  replyText(messageId: string, text: string): Promise<void>;
}

export interface RoleHomeResolver {
  codexHomeFor(role: RoleName): string;
}

export interface ConversationManagerOptions {
  config: TwinnyConfig;
  repository: ConversationRepository;
  workspaces: WorkspaceManagerLike;
  codex: CodexBridge;
  lark: LarkResponder;
  roles: RoleHomeResolver;
  logger?: Logger;
  dedupeTtlMs?: number;
  dedupeMax?: number;
}

interface ActiveThreadResolution {
  threadId: string;
  replacedMissingThread: boolean;
  previousThreadId?: string;
}

export class ConversationManager {
  private readonly queues = new Map<string, SerialQueue>();
  private readonly dedupe: LRUCache<string, true>;
  private readonly log: Logger;

  constructor(private readonly options: ConversationManagerOptions) {
    this.log = options.logger ?? defaultLogger;
    this.dedupe = new LRUCache<string, true>({
      max: options.dedupeMax ?? 1000,
      ttl: options.dedupeTtlMs ?? 10 * 60 * 1000
    });
  }

  async handleIncoming(message: IncomingLarkMessage): Promise<void> {
    if (this.dedupe.has(message.messageId)) {
      this.log.debug({ messageId: message.messageId }, "duplicate lark message ignored");
      return;
    }
    this.dedupe.set(message.messageId, true);

    if (message.messageType !== "text") {
      this.log.debug({ messageId: message.messageId, messageType: message.messageType }, "non-text lark message ignored");
      return;
    }
    const type = conversationTypeForChat(message.chatType);
    if (type !== "p2p") {
      this.log.debug({ messageId: message.messageId, chatType: message.chatType }, "non-p2p lark message ignored");
      return;
    }

    const conversationKey = conversationKeyForP2p(message.senderOpenId);
    const queue = this.getQueue(conversationKey);
    await queue.enqueue(() => this.processMessage(conversationKey, message));
  }

  queueDepth(conversationKey: string): number {
    return this.queues.get(conversationKey)?.depth ?? 0;
  }

  private async processMessage(conversationKey: string, message: IncomingLarkMessage): Promise<void> {
    let reaction: LarkReactionHandle | null = null;
    const startedAt = Date.now();
    try {
      reaction = await this.addReactionBestEffort(message.messageId);
      const role = roleForSender(this.options.config, message.senderOpenId);
      const workspace = await this.options.workspaces.ensureWorkspace(conversationKey);
      const binding = await this.getOrCreateConversation({ conversationKey, role, workspace, message });
      const activeThread = binding.created
        ? { threadId: binding.conversation.codexThreadId, replacedMissingThread: false }
        : await this.resumeExistingThread(binding.conversation, { role, workspace, conversationKey });
      if (activeThread.replacedMissingThread) {
        await this.notifyThreadReplacementBestEffort(
          message.messageId,
          activeThread.previousThreadId,
          activeThread.threadId
        );
      }
      const result = await this.options.codex.startTurn({
        role,
        threadId: activeThread.threadId,
        input: message.text,
        cwd: workspace,
        approvalPolicy: "never",
        onAgentMessage: (agentMessage) => this.replyAgentMessageBestEffort(message.messageId, agentMessage)
      });
      this.log.info(
        {
          messageId: message.messageId,
          conversationKey,
          role,
          codexThreadId: activeThread.threadId,
          durationMs: Date.now() - startedAt
        },
        "conversation turn completed"
      );
    } catch (error) {
      this.log.error({ error, messageId: message.messageId, conversationKey }, "conversation turn failed");
      await this.replyErrorBestEffort(message.messageId, error);
    } finally {
      if (reaction) {
        await this.removeReactionBestEffort(reaction);
      }
    }
  }

  private async getOrCreateConversation(params: {
    conversationKey: string;
    role: RoleName;
    workspace: string;
    message: IncomingLarkMessage;
  }): Promise<{ conversation: ConversationRecord; created: boolean }> {
    const existing = await this.options.repository.findByConversationKey(params.conversationKey);
    if (existing) {
      return { conversation: existing, created: false };
    }
    const thread = await this.options.codex.startThread({
      role: params.role,
      cwd: params.workspace,
      approvalPolicy: "never"
    });
    const conversation = await this.options.repository.create({
      conversationKey: params.conversationKey,
      type: "p2p",
      chatId: params.message.senderOpenId,
      name: conversationNameForMessage(this.options.config, params.role, params.message),
      role: params.role,
      codexThreadId: thread.threadId,
      workspace: params.workspace,
      roleCodexHome: this.options.roles.codexHomeFor(params.role)
    });
    return { conversation, created: true };
  }

  private async resumeExistingThread(
    conversation: ConversationRecord,
    params: { role: RoleName; workspace: string; conversationKey: string }
  ): Promise<ActiveThreadResolution> {
    try {
      const resumed = await this.options.codex.resumeThread({
        role: params.role,
        threadId: conversation.codexThreadId,
        cwd: params.workspace,
        approvalPolicy: "never"
      });
      if (resumed.threadId !== conversation.codexThreadId) {
        await this.options.repository.updateThreadBinding(params.conversationKey, {
          codexThreadId: resumed.threadId,
          role: params.role,
          roleCodexHome: this.options.roles.codexHomeFor(params.role),
          workspace: params.workspace
        });
      }
      return { threadId: resumed.threadId, replacedMissingThread: false };
    } catch (error) {
      if (!isMissingRolloutError(error)) {
        throw error;
      }
      this.log.warn(
        {
          error,
          conversationKey: params.conversationKey,
          codexThreadId: conversation.codexThreadId
        },
        "codex thread rollout missing; starting replacement thread"
      );
      const replacement = await this.options.codex.startThread({
        role: params.role,
        cwd: params.workspace,
        approvalPolicy: "never"
      });
      await this.options.repository.updateThreadBinding(params.conversationKey, {
        codexThreadId: replacement.threadId,
        role: params.role,
        roleCodexHome: this.options.roles.codexHomeFor(params.role),
        workspace: params.workspace
      });
      return {
        threadId: replacement.threadId,
        replacedMissingThread: true,
        previousThreadId: conversation.codexThreadId
      };
    }
  }

  private getQueue(conversationKey: string): SerialQueue {
    const existing = this.queues.get(conversationKey);
    if (existing) {
      return existing;
    }
    const queue = new SerialQueue();
    this.queues.set(conversationKey, queue);
    return queue;
  }

  private async addReactionBestEffort(messageId: string): Promise<LarkReactionHandle | null> {
    try {
      return await this.options.lark.addTypingReaction(messageId);
    } catch (error) {
      this.log.warn({ error, messageId }, "failed to add typing reaction");
      return null;
    }
  }

  private async removeReactionBestEffort(handle: LarkReactionHandle): Promise<void> {
    try {
      await this.options.lark.removeReaction(handle);
    } catch (error) {
      this.log.warn({ error, messageId: handle.messageId, reactionId: handle.reactionId }, "failed to remove typing reaction");
    }
  }

  private async notifyThreadReplacementBestEffort(
    messageId: string,
    previousThreadId: string | undefined,
    newThreadId: string
  ): Promise<void> {
    try {
      await this.options.lark.replyText(
        messageId,
        "WARN: Codex thread state was missing. Twinny created a replacement thread for this conversation; previous context is no longer available."
      );
    } catch (error) {
      this.log.warn(
        { error, messageId, previousThreadId, newThreadId },
        "failed to notify lark about codex thread replacement"
      );
    }
  }

  private async replyErrorBestEffort(messageId: string, error: unknown): Promise<void> {
    try {
      await this.options.lark.replyText(messageId, `处理失败：${toErrorMessage(error)}`);
    } catch (replyError) {
      this.log.error({ error: replyError, messageId }, "failed to send error reply");
    }
  }

  private async replyAgentMessageBestEffort(
    messageId: string,
    agentMessage: { id: string; text: string }
  ): Promise<void> {
    const text = agentMessage.text.trim();
    if (text.length === 0) {
      return;
    }
    try {
      await this.options.lark.replyText(messageId, text);
    } catch (error) {
      this.log.warn({ error, messageId, agentMessageId: agentMessage.id }, "failed to send agent message item to lark");
    }
  }
}

function isMissingRolloutError(error: unknown): boolean {
  if (error instanceof Error && error.message.includes("no rollout found")) {
    return true;
  }
  const cause = isRecord(error) ? error.cause : undefined;
  return isRecord(cause) && typeof cause.message === "string" && cause.message.includes("no rollout found");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function conversationNameForMessage(config: TwinnyConfig, role: RoleName, message: IncomingLarkMessage): string {
  if (role === "owner") {
    return config.owner.displayName.trim() || message.senderName?.trim() || message.senderOpenId;
  }
  return message.senderName?.trim() || message.senderOpenId;
}
