import { LRUCache } from "lru-cache";
import type { Logger } from "pino";
import { TwinnyError, toErrorMessage } from "../errors.js";
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
import { SerialQueue } from "./queue.js";
import { conversationKeyForP2p, conversationTypeForChat, roleForSender } from "./routing.js";

export interface ConversationRepository {
  findByConversationKey(conversationKey: string): Promise<ConversationRecord | null> | ConversationRecord | null;
  create(record: NewConversationRecord): Promise<ConversationRecord> | ConversationRecord;
  updateThreadBinding(
    conversationKey: string,
    update: {
      codexThreadId: string;
      codexThreadHasRollout?: boolean;
      role?: RoleName;
      roleCodexHome?: string;
      workspace?: string;
    }
  ): Promise<ConversationRecord> | ConversationRecord;
  markThreadHasRollout(conversationKey: string, codexThreadId: string): Promise<void> | void;
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
    onTurnStarted?: (turnId: string) => Promise<void> | void;
    onAgentMessage?: (message: { id: string; text: string }) => Promise<void> | void;
  }): Promise<CodexTurnResult>;
  steerTurn(params: {
    role: RoleName;
    threadId: string;
    turnId: string;
    input: string;
    cwd: string;
    approvalPolicy: "never";
  }): Promise<void>;
  interruptTurn(params: {
    role: RoleName;
    threadId: string;
    turnId: string;
  }): Promise<void>;
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

interface PendingMessage {
  messageId: string;
  text: string;
  original: IncomingLarkMessage;
}

interface ActiveTurn {
  runId: number;
  role: RoleName;
  threadId: string;
  workspace: string;
  conversationKey: string;
  replyMessageId: string;
  turnId?: string;
  reaction?: LarkReactionHandle | null;
  pendingSteers: PendingMessage[];
  cancelRequested: boolean;
}

interface ConversationState {
  controlQueue: SerialQueue;
  submittedMessages: Map<string, IncomingLarkMessage>;
  processingMessage?: IncomingLarkMessage;
  active?: ActiveTurn;
  pendingBatch: PendingMessage[];
  nextRunId: number;
}

type ParsedCommand =
  | { kind: "message"; text: string }
  | { kind: "queue"; text: string }
  | { kind: "stop" }
  | { kind: "new" };

export class ConversationManager {
  private static readonly shutdownLostMessage = "服务重启之前的消息丢失";

  private readonly states = new Map<string, ConversationState>();
  private readonly shutdownNotifiedMessageIds = new Set<string>();
  private readonly dedupe: LRUCache<string, true>;
  private readonly log: Logger;
  private shuttingDown = false;

  constructor(private readonly options: ConversationManagerOptions) {
    this.log = options.logger ?? defaultLogger;
    this.dedupe = new LRUCache<string, true>({
      max: options.dedupeMax ?? 1000,
      ttl: options.dedupeTtlMs ?? 10 * 60 * 1000
    });
  }

  submitIncoming(message: IncomingLarkMessage): void {
    if (this.shuttingDown) {
      throw new TwinnyError("Conversation manager is shutting down", "CONVERSATION_MANAGER_SHUTTING_DOWN");
    }
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
    const state = this.getState(conversationKey);
    state.submittedMessages.set(message.messageId, message);
    void state.controlQueue
      .enqueue(() => this.processSubmittedMessage(state, conversationKey, message))
      .catch((error) => {
        void this.handleSubmittedMessageFailure(message, error);
      });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    const replyPromises: Promise<void>[] = [];
    const cancelPromises: Promise<boolean>[] = [];
    for (const state of this.states.values()) {
      const messageIds = new Set<string>();
      for (const submitted of state.submittedMessages.values()) {
        messageIds.add(submitted.messageId);
      }
      state.submittedMessages.clear();
      if (state.processingMessage) {
        messageIds.add(state.processingMessage.messageId);
      }
      for (const pending of this.clearPendingMessages(state)) {
        messageIds.add(pending.messageId);
      }
      if (state.active) {
        messageIds.add(state.active.replyMessageId);
        cancelPromises.push(this.cancelActiveTurn(state));
      }
      for (const messageId of messageIds) {
        replyPromises.push(this.replyShutdownLossBestEffort(messageId));
      }
    }

    await Promise.all([...replyPromises, ...cancelPromises]);
  }

  queueDepth(conversationKey: string): number {
    const state = this.states.get(conversationKey);
    if (!state) {
      return 0;
    }
    return (
      state.controlQueue.depth +
      state.pendingBatch.length +
      (state.active?.pendingSteers.length ?? 0)
    );
  }

  private async processSubmittedMessage(
    state: ConversationState,
    conversationKey: string,
    message: IncomingLarkMessage
  ): Promise<void> {
    const submitted = state.submittedMessages.get(message.messageId);
    if (!submitted) {
      return;
    }
    state.submittedMessages.delete(message.messageId);
    if (this.shuttingDown) {
      await this.replyShutdownLossBestEffort(message.messageId);
      return;
    }

    state.processingMessage = message;
    try {
      await this.routeMessage(state, conversationKey, message);
    } finally {
      if (state.processingMessage?.messageId === message.messageId) {
        state.processingMessage = undefined;
      }
    }
  }

  private async handleSubmittedMessageFailure(message: IncomingLarkMessage, error: unknown): Promise<void> {
    this.log.error({ error, messageId: message.messageId }, "conversation submitted message failed");
    if (this.shuttingDown) {
      await this.replyShutdownLossBestEffort(message.messageId);
      return;
    }
    await this.replyErrorBestEffort(message.messageId, error);
  }

  private async routeMessage(
    state: ConversationState,
    conversationKey: string,
    message: IncomingLarkMessage
  ): Promise<void> {
    const parsed = parseSlashCommand(message.text);
    if (parsed.kind === "stop") {
      await this.handleStopCommand(state, message);
      return;
    }
    if (parsed.kind === "new") {
      await this.handleNewCommand(state, conversationKey, message);
      return;
    }
    if (parsed.kind === "queue") {
      await this.handleQueueCommand(state, conversationKey, message, parsed.text);
      return;
    }
    await this.handleUserMessage(state, conversationKey, message, parsed.text);
  }

  private async handleUserMessage(
    state: ConversationState,
    conversationKey: string,
    message: IncomingLarkMessage,
    text: string
  ): Promise<void> {
    const pending = toPendingMessage(message, text);
    const active = state.active;
    if (state.pendingBatch.length > 0 || active?.cancelRequested) {
      state.pendingBatch.push(pending);
      if (!active) {
        await this.startPendingBatch(state, conversationKey);
      }
      return;
    }

    if (active) {
      await this.steerOrDefer(state, active, pending);
      return;
    }

    await this.startTurnForMessages(state, conversationKey, [pending]);
  }

  private async handleQueueCommand(
    state: ConversationState,
    conversationKey: string,
    message: IncomingLarkMessage,
    text: string
  ): Promise<void> {
    if (!text) {
      await this.replyControlBestEffort(message.messageId, "用法：/queue <message>");
      return;
    }

    state.pendingBatch.push(toPendingMessage(message, text));
    if (!state.active) {
      await this.startPendingBatch(state, conversationKey);
    }
  }

  private async handleStopCommand(state: ConversationState, message: IncomingLarkMessage): Promise<void> {
    const cleared = this.clearPendingMessages(state).length;
    const interrupted = await this.cancelActiveTurn(state);
    const summary = interrupted
      ? `已停止当前任务，清空 ${cleared} 条待处理消息。`
      : `当前没有正在运行的任务，清空 ${cleared} 条待处理消息。`;
    await this.replyControlBestEffort(message.messageId, summary);
  }

  private async handleNewCommand(
    state: ConversationState,
    conversationKey: string,
    message: IncomingLarkMessage
  ): Promise<void> {
    this.clearPendingMessages(state);
    await this.cancelActiveTurn(state);
    const role = roleForSender(this.options.config, message.senderOpenId);
    const workspace = await this.options.workspaces.ensureWorkspace(conversationKey);
    const thread = await this.options.codex.startThread({
      role,
      cwd: workspace,
      approvalPolicy: "never"
    });

    const existing = await this.options.repository.findByConversationKey(conversationKey);
    if (existing) {
      await this.options.repository.updateThreadBinding(conversationKey, {
        codexThreadId: thread.threadId,
        codexThreadHasRollout: false,
        role,
        roleCodexHome: this.options.roles.codexHomeFor(role),
        workspace
      });
    } else {
      await this.options.repository.create({
        conversationKey,
        type: "p2p",
        chatId: message.senderOpenId,
        name: conversationNameForMessage(this.options.config, role, message),
        role,
        codexThreadId: thread.threadId,
        codexThreadHasRollout: false,
        workspace,
        roleCodexHome: this.options.roles.codexHomeFor(role)
      });
    }
    await this.replyControlBestEffort(message.messageId, `已新开 Codex thread：${thread.threadId}`);
  }

  private async steerOrDefer(
    state: ConversationState,
    active: ActiveTurn,
    message: PendingMessage
  ): Promise<void> {
    if (!active.turnId) {
      active.pendingSteers.push(message);
      active.replyMessageId = message.messageId;
      await this.moveReactionBestEffort(active, message.messageId);
      return;
    }

    try {
      await this.options.codex.steerTurn({
        role: active.role,
        threadId: active.threadId,
        turnId: active.turnId,
        input: message.text,
        cwd: active.workspace,
        approvalPolicy: "never"
      });
      active.replyMessageId = message.messageId;
      await this.moveReactionBestEffort(active, message.messageId);
    } catch (error) {
      this.log.warn(
        { error, threadId: active.threadId, turnId: active.turnId, messageId: message.messageId },
        "failed to steer active codex turn; queueing message for next turn"
      );
      state.pendingBatch.push(message);
      await this.replyControlBestEffort(message.messageId, "当前任务已不可打断注入，已加入下一轮队列。");
    }
  }

  private async startPendingBatch(state: ConversationState, conversationKey: string): Promise<void> {
    if (state.active || state.pendingBatch.length === 0) {
      return;
    }
    const messages = state.pendingBatch.splice(0);
    await this.startTurnForMessages(state, conversationKey, messages);
  }

  private async startTurnForMessages(
    state: ConversationState,
    conversationKey: string,
    messages: PendingMessage[]
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const anchor = messages[messages.length - 1]!;
    const role = roleForSender(this.options.config, anchor.original.senderOpenId);
    const workspace = await this.options.workspaces.ensureWorkspace(conversationKey);
    const binding = await this.getOrCreateConversation({ conversationKey, role, workspace, message: anchor.original });
    const activeThread = binding.created
      ? { threadId: binding.conversation.codexThreadId, replacedMissingThread: false }
      : binding.conversation.codexThreadHasRollout
        ? await this.resumeExistingThread(binding.conversation, { role, workspace, conversationKey })
        : { threadId: binding.conversation.codexThreadId, replacedMissingThread: false };
    if (activeThread.replacedMissingThread) {
      await this.notifyThreadReplacementBestEffort(anchor.messageId, activeThread.previousThreadId, activeThread.threadId);
    }

    const active: ActiveTurn = {
      runId: ++state.nextRunId,
      role,
      threadId: activeThread.threadId,
      workspace,
      conversationKey,
      replyMessageId: anchor.messageId,
      reaction: await this.addReactionBestEffort(anchor.messageId),
      pendingSteers: [],
      cancelRequested: false
    };
    state.active = active;
    const input = messages.map((message) => message.text).join("\n");
    const startedAt = Date.now();

    void this.options.codex
      .startTurn({
        role,
        threadId: active.threadId,
        input,
        cwd: workspace,
        approvalPolicy: "never",
        onTurnStarted: (turnId) => this.handleTurnStarted(state, active, turnId),
        onAgentMessage: (agentMessage) => this.replyAgentMessageForActiveBestEffort(state, active, agentMessage)
      })
      .then((result) => {
        this.log.info(
          {
            messageId: anchor.messageId,
            conversationKey,
            role,
            codexThreadId: active.threadId,
            turnId: result.turnId,
            status: result.status,
            durationMs: Date.now() - startedAt
          },
          "conversation turn completed"
        );
      })
      .catch(async (error) => {
        if (state.active === active && !active.cancelRequested) {
          this.log.error({ error, messageId: active.replyMessageId, conversationKey }, "conversation turn failed");
          await this.replyErrorBestEffort(active.replyMessageId, error);
        } else {
          this.log.debug({ error, conversationKey, threadId: active.threadId }, "ignored stale codex turn failure");
        }
      })
      .finally(() => {
        void state.controlQueue.enqueue(() => this.finishActiveTurn(state, conversationKey, active));
      });
  }

  private async handleTurnStarted(state: ConversationState, active: ActiveTurn, turnId: string): Promise<void> {
    await state.controlQueue.enqueue(async () => {
      if (active.turnId && active.turnId !== turnId) {
        return;
      }
      active.turnId = turnId;
      if (active.cancelRequested) {
        await this.interruptActiveTurnBestEffort(active);
        return;
      }
      if (state.active !== active) {
        return;
      }
      await this.options.repository.markThreadHasRollout(active.conversationKey, active.threadId);
      await this.flushPendingSteers(state, active);
    });
  }

  private async flushPendingSteers(state: ConversationState, active: ActiveTurn): Promise<void> {
    if (!active.turnId || active.pendingSteers.length === 0) {
      return;
    }

    const pending = active.pendingSteers.splice(0);
    for (let index = 0; index < pending.length; index += 1) {
      if (state.active !== active || active.cancelRequested || !active.turnId) {
        state.pendingBatch.unshift(...pending.slice(index));
        return;
      }
      const message = pending[index]!;
      try {
        await this.options.codex.steerTurn({
          role: active.role,
          threadId: active.threadId,
          turnId: active.turnId,
          input: message.text,
          cwd: active.workspace,
          approvalPolicy: "never"
        });
      } catch (error) {
        this.log.warn(
          { error, threadId: active.threadId, turnId: active.turnId, messageId: message.messageId },
          "failed to flush pending steer messages; queueing remaining messages"
        );
        state.pendingBatch.unshift(...pending.slice(index));
        return;
      }
    }
  }

  private async finishActiveTurn(
    state: ConversationState,
    conversationKey: string,
    active: ActiveTurn
  ): Promise<void> {
    if (state.active !== active) {
      await this.clearReactionBestEffort(active);
      return;
    }
    state.active = undefined;
    await this.clearReactionBestEffort(active);
    await this.startPendingBatch(state, conversationKey);
  }

  private clearPendingMessages(state: ConversationState): PendingMessage[] {
    const activePending = state.active?.pendingSteers.splice(0) ?? [];
    if (state.active) {
      state.active.pendingSteers = [];
    }
    const batchPending = state.pendingBatch.splice(0);
    return [...activePending, ...batchPending];
  }

  private async cancelActiveTurn(state: ConversationState): Promise<boolean> {
    const active = state.active;
    if (!active) {
      return false;
    }
    state.active = undefined;
    active.cancelRequested = true;
    active.pendingSteers = [];
    await this.clearReactionBestEffort(active);
    if (active.turnId) {
      await this.interruptActiveTurnBestEffort(active);
    }
    return true;
  }

  private async interruptActiveTurnBestEffort(active: ActiveTurn): Promise<void> {
    if (!active.turnId) {
      return;
    }
    try {
      await this.options.codex.interruptTurn({
        role: active.role,
        threadId: active.threadId,
        turnId: active.turnId
      });
    } catch (error) {
      this.log.warn({ error, threadId: active.threadId, turnId: active.turnId }, "failed to interrupt codex turn");
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
      codexThreadHasRollout: false,
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
          codexThreadHasRollout: true,
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
        codexThreadHasRollout: false,
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

  private getState(conversationKey: string): ConversationState {
    const existing = this.states.get(conversationKey);
    if (existing) {
      return existing;
    }
    const state: ConversationState = {
      controlQueue: new SerialQueue(),
      submittedMessages: new Map(),
      pendingBatch: [],
      nextRunId: 0
    };
    this.states.set(conversationKey, state);
    return state;
  }

  private async addReactionBestEffort(messageId: string): Promise<LarkReactionHandle | null> {
    try {
      return await this.options.lark.addTypingReaction(messageId);
    } catch (error) {
      this.log.warn({ error, messageId }, "failed to add typing reaction");
      return null;
    }
  }

  private async moveReactionBestEffort(active: ActiveTurn, messageId: string): Promise<void> {
    if (active.reaction?.messageId === messageId) {
      return;
    }
    const previous = active.reaction;
    const next = await this.addReactionBestEffort(messageId);
    if (next) {
      active.reaction = next;
      if (previous) {
        await this.removeReactionBestEffort(previous);
      }
    }
  }

  private async clearReactionBestEffort(active: ActiveTurn): Promise<void> {
    const reaction = active.reaction;
    active.reaction = null;
    if (reaction) {
      await this.removeReactionBestEffort(reaction);
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

  private async replyControlBestEffort(messageId: string, text: string): Promise<void> {
    try {
      await this.options.lark.replyText(messageId, text);
    } catch (error) {
      this.log.warn({ error, messageId }, "failed to send lark control reply");
    }
  }

  private async replyShutdownLossBestEffort(messageId: string): Promise<void> {
    if (this.shutdownNotifiedMessageIds.has(messageId)) {
      return;
    }
    this.shutdownNotifiedMessageIds.add(messageId);
    await this.replyControlBestEffort(messageId, ConversationManager.shutdownLostMessage);
  }

  private async replyErrorBestEffort(messageId: string, error: unknown): Promise<void> {
    try {
      await this.options.lark.replyText(messageId, `处理失败：${toErrorMessage(error)}`);
    } catch (replyError) {
      this.log.error({ error: replyError, messageId }, "failed to send error reply");
    }
  }

  private async replyAgentMessageForActiveBestEffort(
    state: ConversationState,
    active: ActiveTurn,
    agentMessage: { id: string; text: string }
  ): Promise<void> {
    if (state.active !== active || active.cancelRequested) {
      return;
    }
    await this.replyAgentMessageBestEffort(active.replyMessageId, agentMessage);
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

function parseSlashCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return { kind: "message", text };
  }

  const command = match[1]!.toLowerCase();
  const rest = match[2]?.trim() ?? "";
  if (command === "stop") {
    return { kind: "stop" };
  }
  if (command === "new") {
    return { kind: "new" };
  }
  if (command === "queue") {
    return { kind: "queue", text: rest };
  }
  return { kind: "message", text };
}

function toPendingMessage(message: IncomingLarkMessage, text: string): PendingMessage {
  return {
    messageId: message.messageId,
    text,
    original: message
  };
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
