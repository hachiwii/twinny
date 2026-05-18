import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { TwinnyError, toErrorMessage } from "../errors.js";
import {
  imageElement,
  markdownElement,
  mediaElement,
  renderTwinnyAgentCard,
  renderTwinnyThreadSummaryCard,
  type LarkCardElement,
  type LarkCardJson,
  type TwinnyAgentCardMessage
} from "../lark/cards.js";
import { normalizeIncomingLarkMessage } from "../lark/filters.js";
import { isLarkMessageUnavailableError } from "../lark/messages.js";
import { logger as defaultLogger } from "../observability/logs.js";
import type {
  CodexThreadTokenUsageUpdate,
  CodexTurnResult,
  CodexAgentMessage,
  AgentMessageMode,
  ConversationResponseMode,
  ConversationRecord,
  ConversationType,
  IncomingLarkBotMenuAction,
  IncomingLarkCardAction,
  IncomingLarkMessage,
  IncomingLarkMessageRecall,
  LarkMessageRecord,
  LarkMessageRouteKind,
  LarkMessageStatus,
  LarkReactionHandle,
  NewConversationRecord,
  RoleName,
  CodexThreadRecord,
  TwinnyConfig,
  LarkChatMode,
  LarkGroupMessageType
} from "../types.js";
import type { LarkSendMessageResult } from "../lark/types.js";
import { SerialQueue } from "./queue.js";
import {
  conversationKeyForChat,
  conversationKeyForGroup,
  conversationKeyForP2p,
  conversationTypeForChat,
  isGroupConversationType,
  roleForSender
} from "./routing.js";

export interface ConversationRepository {
  findByConversationKey(conversationKey: string): Promise<ConversationRecord | null> | ConversationRecord | null;
  create(record: NewConversationRecord): Promise<ConversationRecord> | ConversationRecord;
  updateThreadBinding(
    conversationKey: string,
    update: {
      codexThreadId: string;
      role?: RoleName;
      roleCodexHome?: string;
      workspace?: string;
    }
  ): Promise<ConversationRecord> | ConversationRecord;
  updateConversationSettings(
    conversationKey: string,
    update: { type?: ConversationType; name?: string; chatMode?: LarkChatMode; responseMode?: ConversationResponseMode }
  ): Promise<ConversationRecord> | ConversationRecord;
  markThreadHasRollout(conversationKey: string, codexThreadId: string): Promise<void> | void;
  getCodexThreadById(codexThreadId: string): Promise<CodexThreadRecord | undefined> | CodexThreadRecord | undefined;
  getCodexThreadByConversationAndLarkThread(
    conversationKey: string,
    larkThreadId: string
  ): Promise<CodexThreadRecord | undefined> | CodexThreadRecord | undefined;
  getLarkMessageById(larkMessageId: string): Promise<unknown | undefined> | unknown | undefined;
  getLarkMessageByEventId(eventId: string): Promise<unknown | undefined> | unknown | undefined;
  listUnfinishedLarkMessages(): Promise<LarkMessageRecord[]> | LarkMessageRecord[];
  upsertCodexThread(input: {
    codexThreadId: string;
    conversationKey: string;
    role: RoleName;
    larkThreadId?: string;
    codexThreadHasRollout?: boolean;
  }): Promise<unknown> | unknown;
  replaceCodexThreadForLarkThread?(
    conversationKey: string,
    larkThreadId: string,
    update: { codexThreadId: string; role: RoleName; codexThreadHasRollout?: boolean }
  ): Promise<CodexThreadRecord> | CodexThreadRecord;
  updateCodexThreadTokenUsage(input: {
    codexThreadId: string;
    conversationKey: string;
    role: RoleName;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
    contextTokens: number;
    contextWindow: number;
    tokenUsageJson: string;
  }): Promise<unknown> | unknown;
  updateCodexThreadCard(input: {
    codexThreadId: string;
    conversationKey: string;
    role: RoleName;
    larkThreadId?: string;
    creatorOpenId?: string;
    cardMessageId?: string;
  }): Promise<CodexThreadRecord> | CodexThreadRecord;
  getCodexThreadWorkStats(codexThreadId: string): Promise<{ turnCount: number; totalWorkDurationMs: number }> | {
    turnCount: number;
    totalWorkDurationMs: number;
  };
  insertLarkMessage(input: {
    larkMessageId?: string;
    eventId: string;
    larkUserId: string;
    larkGroupId?: string;
    larkThreadId?: string;
    conversationKey?: string;
    codexThreadId?: string;
    codexTurnId?: string;
    routeKind: LarkMessageRouteKind;
    status: LarkMessageStatus;
    text: string;
    larkCreateTime?: number;
    rawEventJson?: string;
  }): Promise<unknown> | unknown;
  markLarkMessageQueued(larkMessageId: string): Promise<void> | void;
  markLarkMessageRecalled(larkMessageId: string): Promise<boolean> | boolean;
  updateQueuedLarkMessage(
    larkMessageId: string,
    update: { text: string; rawEventJson?: string }
  ): Promise<boolean> | boolean;
  markLarkMessagesProcessing(
    larkMessageIds: string[],
    update?: { conversationKey?: string; codexThreadId?: string; codexTurnId?: string }
  ): Promise<void> | void;
  markLarkMessagesSteered(
    larkMessageIds: string[],
    update?: { conversationKey?: string; codexThreadId?: string; codexTurnId?: string }
  ): Promise<void> | void;
  markLarkMessagesCompleted(larkMessageIds: string[]): Promise<void> | void;
  markLarkMessagesFailed(larkMessageIds: string[]): Promise<void> | void;
  markLarkMessagesInterrupted(larkMessageIds: string[]): Promise<void> | void;
  markLarkMessagesCleared(larkMessageIds: string[]): Promise<void> | void;
}

export interface LarkUserDirectory {
  getUserNameByOpenId(openId: string): Promise<string | undefined>;
}

export interface LarkChatDirectory {
  getChatInfo?(chatId: string): Promise<{
    name?: string;
    chatMode?: LarkChatMode;
    groupMessageType?: LarkGroupMessageType;
  } | undefined>;
  getChatName?(chatId: string): Promise<string | undefined>;
  createChat?(input: {
    name: string;
    ownerOpenId?: string;
    userOpenIds?: string[];
    groupMessageType?: LarkGroupMessageType;
    uuid?: string;
    setBotManager?: boolean;
  }): Promise<{ chatId?: string; raw: unknown }>;
}

export interface LarkFileDownloader {
  downloadMessageResource(params: {
    messageId: string;
    resourceType: "image" | "file";
    fileKey: string;
    fileName?: string;
    outputDir: string;
  }): Promise<{
    path: string;
    resourceType: "image" | "file";
    fileKey: string;
    fileName?: string;
    size: number;
    contentType?: string;
  }>;
  uploadImage?(params: { filePath: string; fileName?: string; contentType?: string }): Promise<{ imageKey: string; raw?: unknown }>;
  uploadFile?(params: {
    filePath: string;
    fileName?: string;
    fileType?: string;
    contentType?: string;
    durationMs?: number;
  }): Promise<{ fileKey: string; raw?: unknown }>;
}

export interface LarkMessageReader {
  getMessage(messageId: string): Promise<unknown>;
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
    onAgentMessage?: (message: CodexAgentMessage) => Promise<void> | void;
    onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
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
  readAccountRateLimits?(params: { role: RoleName }): Promise<unknown>;
}

export interface LarkResponder {
  addTypingReaction(messageId: string): Promise<LarkReactionHandle | null>;
  addCompletedReaction(messageId: string): Promise<LarkReactionHandle | null>;
  addQueuedReaction(messageId: string): Promise<LarkReactionHandle | null>;
  removeReaction(handle: LarkReactionHandle): Promise<void>;
  replyText(messageId: string, text: string): Promise<void>;
  replyMarkdown(messageId: string, markdown: string): Promise<{ messageId?: string } | void>;
  replyRawMessage(
    messageId: string,
    message: { messageType: string; content: unknown }
  ): Promise<{ messageId?: string } | void>;
  replyPost(
    messageId: string,
    content: Array<Array<{ tag: "md"; text: string } | { tag: "img"; image_key: string } | { tag: "media"; file_key: string }>>
  ): Promise<{ messageId?: string } | void>;
  replyFile(messageId: string, fileKey: string): Promise<{ messageId?: string } | void>;
  sendTextToOpenId(openId: string, text: string): Promise<void>;
  sendCardToChatId(
    chatId: string,
    card: LarkCardJson,
    options?: { uuid?: string }
  ): Promise<LarkSendMessageResult | void>;
  forwardThreadToThread(threadId: string, receiveThreadId: string, options?: { uuid?: string }): Promise<LarkSendMessageResult | void>;
  replyCard(messageId: string, card: LarkCardJson): Promise<{ messageId?: string } | void>;
  patchCard(messageId: string, card: LarkCardJson): Promise<{ messageId?: string } | void>;
  recallMessage(messageId: string): Promise<void>;
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
  larkUsers?: LarkUserDirectory;
  larkChats?: LarkChatDirectory;
  larkFiles?: LarkFileDownloader;
  larkMessages?: LarkMessageReader;
  botOpenId?: string;
  roles: RoleHomeResolver;
  logger?: Logger;
  nameLookupFailureTtlMs?: number;
}

interface ActiveThreadResolution {
  threadId: string;
  replacedMissingThread: boolean;
  previousThreadId?: string;
  created?: boolean;
}

interface NewSessionTopicRequest {
  chatId: string;
  operatorOpenId: string;
  eventId: string;
}

interface CreatedSessionTopic {
  codexThreadId: string;
  larkThreadId: string;
  cardMessageId: string;
}

interface MessageContext {
  type: ConversationType;
  conversationKey: string;
  stateKey: string;
  larkThreadId?: string;
}

interface ConversationActor {
  senderOpenId: string;
  senderName?: string;
  chatId?: string;
  chatName?: string;
}

interface PendingMessage {
  messageId: string;
  text: string;
  original: IncomingLarkMessage;
  queueBoundary: boolean;
  queuedReaction?: LarkReactionHandle | null;
}

interface ActiveTurn {
  runId: number;
  agentMessageMode: AgentMessageMode;
  role: RoleName;
  threadId: string;
  workspace: string;
  conversationKey: string;
  context: MessageContext;
  replyMessageId: string;
  startedAt: number;
  turnId?: string;
  reaction?: LarkReactionHandle | null;
  lastAgentReplyMessageId?: string;
  completedStatus?: CodexTurnResult["status"];
  resultText?: string;
  resultError?: string;
  finalAgentMessageText?: string;
  sawAgentMessagePhase?: boolean;
  card?: ActiveTurnCardState;
  pendingSteers: PendingMessage[];
  messagesById: Map<string, PendingMessage>;
  messageIds: Set<string>;
  processingMessageIds: Set<string>;
  steeredMessageIds: Set<string>;
  cancelRequested: boolean;
}

interface ActiveTurnCardState {
  anchorMessageId: string;
  messageId?: string;
  startedAt: number;
  messages: TwinnyAgentCardMessage[];
  timer?: NodeJS.Timeout;
  fallbackPlain: boolean;
  lastRenderedJson?: string;
}

interface ConversationState {
  controlQueue: SerialQueue;
  submittedMessages: Map<string, IncomingLarkMessage>;
  processingMessage?: IncomingLarkMessage;
  active?: ActiveTurn;
  pendingBatch: PendingMessage[];
  queueNextMessage: boolean;
  nextRunId: number;
}

type ParsedCommand =
  | { kind: "message"; text: string }
  | { kind: "queue"; text: string }
  | { kind: "stop" }
  | { kind: "next" }
  | { kind: "steer" }
  | { kind: "status" }
  | { kind: "new" }
  | { kind: "new_topic" }
  | { kind: "project"; name: string }
  | { kind: "activate"; text: string }
  | { kind: "deactivate" }
  | { kind: "help" };

interface ParsedCardActionCommand {
  action: "stop" | "next" | "queue";
  stateKey: string;
  runId: number;
  text: "/stop" | "/next" | "/queue";
}

export class ConversationManager {
  private static readonly recoveryPrompt = "Twinny daemon has beed reloaded, continue with the unfinished work.";

  private readonly states = new Map<string, ConversationState>();
  private readonly nameLookupFailureCache = new Map<string, number>();
  private readonly log: Logger;
  private shuttingDown = false;

  constructor(private readonly options: ConversationManagerOptions) {
    this.log = options.logger ?? defaultLogger;
  }

  submitIncoming(message: IncomingLarkMessage): void {
    if (this.shuttingDown) {
      throw new TwinnyError("Conversation manager is shutting down", "CONVERSATION_MANAGER_SHUTTING_DOWN");
    }
    const type = conversationTypeForChat(message.chatType);
    if (!type) {
      this.log.debug({ messageId: message.messageId, chatType: message.chatType }, "unsupported lark message chat type ignored");
      return;
    }

    const context = createMessageContext(type, message);
    const state = this.getState(context.stateKey);
    state.submittedMessages.set(message.messageId, message);
    void state.controlQueue
      .enqueue(() => this.processSubmittedMessage(state, context, message))
      .catch((error) => {
        void this.handleSubmittedMessageFailure(message, error);
      });
  }

  submitMessageRecall(recall: IncomingLarkMessageRecall): void {
    if (this.shuttingDown) {
      throw new TwinnyError("Conversation manager is shutting down", "CONVERSATION_MANAGER_SHUTTING_DOWN");
    }

    void this.enqueueQueuedMessageChange(recall.messageId, (state, conversationKey) =>
      this.processQueuedMessageRecall(state, conversationKey, recall)
    ).catch((error) => {
      this.log.error({ error, messageId: recall.messageId }, "conversation message recall failed");
    });
  }

  submitBotMenuAction(action: IncomingLarkBotMenuAction): void {
    if (this.shuttingDown) {
      throw new TwinnyError("Conversation manager is shutting down", "CONVERSATION_MANAGER_SHUTTING_DOWN");
    }

    const context = action.action === "new_session" && action.chatId
      ? createBotMenuGroupContext(action.chatId)
      : createBotMenuContext(action.operatorOpenId);
    const state = this.getState(context.stateKey);
    void state.controlQueue
      .enqueue(() => this.processBotMenuAction(state, context, action))
      .catch((error) => {
        this.log.error(
          { error, eventId: action.eventId, eventKey: action.eventKey, operatorOpenId: action.operatorOpenId },
          "conversation bot menu action failed"
        );
      });
  }

  submitCardAction(action: IncomingLarkCardAction): void {
    if (this.shuttingDown) {
      throw new TwinnyError("Conversation manager is shutting down", "CONVERSATION_MANAGER_SHUTTING_DOWN");
    }
    const command = parseTwinnyCardAction(action.actionValue);
    if (!command) {
      this.log.debug({ eventId: action.eventId }, "ignored non-twinny card action");
      return;
    }

    const state = this.states.get(command.stateKey);
    if (!state) {
      void this.recordCardActionBestEffort(action, command, "completed").catch((error) => {
        this.log.warn({ error, eventId: action.eventId }, "failed to record stale card action");
      });
      return;
    }

    void state.controlQueue.enqueue(() => this.processCardAction(state, action, command)).catch((error) => {
      this.log.error({ error, eventId: action.eventId }, "conversation card action failed");
    });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    const cancelPromises: Promise<boolean>[] = [];
    for (const state of this.states.values()) {
      state.submittedMessages.clear();
      state.processingMessage = undefined;
      state.queueNextMessage = false;
      await this.clearPendingMessagesBestEffort(state);
      cancelPromises.push(this.suspendActiveTurnForShutdown(state));
    }

    await Promise.all(cancelPromises);
  }

  async recoverUnfinishedMessages(): Promise<void> {
    const records = await this.options.repository.listUnfinishedLarkMessages();
    if (records.length === 0) {
      return;
    }

    const processingGroups = new Map<
      string,
      { state: ConversationState; context: MessageContext; records: LarkMessageRecord[]; messages: PendingMessage[] }
    >();
    const recoverableStates = new Map<string, { state: ConversationState; context: MessageContext }>();

    for (const record of records) {
      const context = contextForRecoveredRecord(record);
      const state = this.getState(context.stateKey);
      recoverableStates.set(context.stateKey, { state, context });
      const message = await this.toRecoveredPendingMessage(record, context);
      if (record.status === "processing") {
        const group = processingGroups.get(context.stateKey) ?? { state, context, records: [], messages: [] };
        group.records.push(record);
        group.messages.push(message);
        processingGroups.set(context.stateKey, group);
      } else if (record.status === "queued") {
        state.pendingBatch.push(message);
      }
    }

    for (const group of processingGroups.values()) {
      await group.state.controlQueue.enqueue(() =>
        this.startRecoveredProcessingMessages(group.state, group.context, group.records, group.messages)
      );
    }
    for (const { state, context } of recoverableStates.values()) {
      await state.controlQueue.enqueue(() => this.startPendingBatch(state, context));
    }
  }

  private async toRecoveredPendingMessage(record: LarkMessageRecord, context: MessageContext): Promise<PendingMessage> {
    const raw = parseStoredRawEvent(record.rawEventJson);
    const normalized = normalizeIncomingLarkMessage(raw);
    if (!normalized) {
      throw new TwinnyError(
        `Cannot recover Lark message ${record.larkMessageId} from raw event JSON`,
        "LARK_MESSAGE_RECOVERY_FAILED"
      );
    }
    normalized.senderName = await this.resolveSenderName(context, normalized, roleForSender(this.options.config, normalized.senderOpenId));
    if (record.status === "queued") {
      await this.prepareMessageResources(context.conversationKey, normalized);
    }
    const text = (record.status === "queued" && (normalized.resources?.length ?? 0) > 0) ? normalized.text : record.text;
    return toPendingMessage(normalized, text, {
      queueBoundary: record.status === "queued" && parseSlashCommand(normalized.text).kind === "queue"
    });
  }

  private async startRecoveredProcessingMessages(
    state: ConversationState,
    context: MessageContext,
    records: LarkMessageRecord[],
    messages: PendingMessage[]
  ): Promise<void> {
    if (state.active || messages.length === 0) {
      return;
    }
    const anchor = messages[messages.length - 1]!;
    const conversation = await this.getOrCreateRecoveryConversation(context, records, anchor.original);
    const role = conversation.role;
    const workspace = conversation.workspace;
    const activeThread = await this.resolveActiveThread({ conversation, created: false }, { role, workspace, context });
    if (activeThread.replacedMissingThread) {
      await this.notifyThreadReplacementBestEffort(anchor.messageId, activeThread.previousThreadId, activeThread.threadId);
    }
    await this.recordCodexThreadBestEffort({
      conversationKey: context.conversationKey,
      codexThreadId: activeThread.threadId,
      role,
      larkThreadId: context.larkThreadId
    });
    await this.beginActiveTurn(state, context, {
      messages,
      role,
      threadId: activeThread.threadId,
      workspace,
      input: ConversationManager.recoveryPrompt
    });
  }

  private async getOrCreateRecoveryConversation(
    context: MessageContext,
    records: LarkMessageRecord[],
    message: IncomingLarkMessage
  ): Promise<ConversationRecord> {
    const existing = await this.options.repository.findByConversationKey(context.conversationKey);
    if (existing) {
      return existing;
    }
    const role = roleForSender(this.options.config, message.senderOpenId);
    const workspace = await this.options.workspaces.ensureWorkspace(context.conversationKey);
    const recoveredThreadId = lastDefined(records.map((record) => record.codexThreadId));
    const threadId =
      recoveredThreadId ??
      (
        await this.options.codex.startThread({
          role,
          cwd: workspace,
          approvalPolicy: "never"
        })
      ).threadId;
    const conversation = await this.options.repository.create({
      conversationKey: context.conversationKey,
      type: context.type,
      chatId: context.type === "p2p" ? message.senderOpenId : message.chatId,
      name: conversationNameForMessage(this.options.config, role, message),
      responseMode: context.type === "p2p" ? "all" : "at",
      role,
      codexThreadId: threadId,
      workspace,
      roleCodexHome: this.options.roles.codexHomeFor(role)
    });
    await this.recordCodexThreadBestEffort({
      conversationKey: context.conversationKey,
      codexThreadId: threadId,
      role,
      codexThreadHasRollout: recoveredThreadId !== undefined
    });
    return conversation;
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

  private async processBotMenuAction(
    state: ConversationState,
    context: MessageContext,
    action: IncomingLarkBotMenuAction
  ): Promise<void> {
    const existing = await this.options.repository.getLarkMessageByEventId(action.eventId);
    if (existing) {
      return;
    }

    const active = state.active;
    let status: LarkMessageStatus = "completed";
    try {
      switch (action.action) {
        case "queue": {
          state.queueNextMessage = !state.queueNextMessage;
          if (state.active) {
            await this.patchAgentCardBestEffort(state, state.active, "working");
          }
          await this.sendDirectControlBestEffort(
            action.operatorOpenId,
            state.queueNextMessage
              ? "开启排队模式：你的下一条消息会排队等待当前工作结束。"
              : "退出排队模式：下一条消息会即时提交给模型。"
          );
          return;
        }
        case "stop": {
          const { cleared, interrupted } = await this.stopConversationState(state);
          await this.sendDirectControlBestEffort(
            action.operatorOpenId,
            interrupted
              ? `已停止当前任务，清空 ${cleared} 条待处理消息。`
              : `当前没有正在运行的任务，清空 ${cleared} 条待处理消息。`
          );
          return;
        }
        case "new": {
          const threadId = await this.openNewThreadForMessage(state, context, messageForBotMenuAction(action));
          await this.sendDirectControlBestEffort(action.operatorOpenId, `已新开 Codex thread：${threadId}`);
          return;
        }
        case "new_session": {
          await this.handleNewSessionMenuAction(context, action);
          return;
        }
        case "status": {
          await this.sendDirectControlBestEffort(
            action.operatorOpenId,
            await this.formatStatusText(state, context, {
              senderOpenId: action.operatorOpenId,
              senderName: action.operatorName,
              chatId: action.operatorOpenId
            })
          );
          return;
        }
        case "help": {
          await this.sendDirectControlBestEffort(
            action.operatorOpenId,
            helpTextFor(messageForBotMenuAction(action), context, this.options.config)
          );
          return;
        }
      }
    } catch (error) {
      status = "failed";
      throw error;
    } finally {
      await this.recordMenuActionBestEffort(action, context, status, active);
    }
  }

  private async processSubmittedMessage(
    state: ConversationState,
    context: MessageContext,
    message: IncomingLarkMessage
  ): Promise<void> {
    const submitted = state.submittedMessages.get(message.messageId);
    if (!submitted) {
      return;
    }
    state.submittedMessages.delete(message.messageId);
    if (this.shuttingDown) {
      return;
    }

    state.processingMessage = message;
    try {
      if (await this.isPersistedDuplicateMessage(message)) {
        return;
      }
      await this.routeMessage(state, context, message);
    } catch (error) {
      await this.markMessagesFailedBestEffort([message.messageId]);
      throw error;
    } finally {
      if (state.processingMessage?.messageId === message.messageId) {
        state.processingMessage = undefined;
      }
    }
  }

  private async handleSubmittedMessageFailure(message: IncomingLarkMessage, error: unknown): Promise<void> {
    this.log.error({ error, messageId: message.messageId }, "conversation submitted message failed");
    if (this.shuttingDown) {
      return;
    }
    await this.replyErrorBestEffort(message.messageId, error);
  }

  private async isPersistedDuplicateMessage(message: IncomingLarkMessage): Promise<boolean> {
    const existing = await this.options.repository.getLarkMessageByEventId(message.eventId);
    if (!existing) {
      return false;
    }
    this.log.debug({ eventId: message.eventId, messageId: message.messageId }, "persisted duplicate lark event ignored");
    return true;
  }

  private async enqueueQueuedMessageChange(
    larkMessageId: string,
    handler: (state: ConversationState, conversationKey: string) => Promise<void>
  ): Promise<void> {
    const record = queuedLarkMessageRecord(await this.options.repository.getLarkMessageById(larkMessageId));
    if (!record) {
      this.log.debug({ messageId: larkMessageId }, "ignored lark message change for non-queued message");
      return;
    }

    const conversationKey = record.conversationKey ?? conversationKeyForP2p(record.larkUserId);
    const state = this.getState(conversationKey);
    await state.controlQueue.enqueue(() => handler(state, conversationKey));
  }

  private async processQueuedMessageRecall(
    state: ConversationState,
    _conversationKey: string,
    recall: IncomingLarkMessageRecall
  ): Promise<void> {
    const record = queuedLarkMessageRecord(await this.options.repository.getLarkMessageById(recall.messageId));
    if (!record) {
      return;
    }

    const removed = removePendingMessageById(state.pendingBatch, recall.messageId);
    if (removed) {
      await this.clearQueuedReactionBestEffort(removed);
    }
    await this.markMessageRecalledBestEffort(recall.messageId);
  }

  private async routeMessage(
    state: ConversationState,
    context: MessageContext,
    message: IncomingLarkMessage
  ): Promise<void> {
    const routed = await this.applyGroupResponsePolicy(context, message);
    if (routed.kind === "ignored") {
      return;
    }
    if (routed.kind === "unauthorized") {
      await this.replyGroupUnauthorizedBestEffort(message.messageId);
      return;
    }

    message.text = routed.text;
    const parsed = routed.parsed;
    if (parsed.kind === "activate") {
      await this.handleActivateCommand(state, context, message, parsed.text);
      return;
    }

    await this.prepareMessageResources(context.conversationKey, message);
    const preparedParsed: ParsedCommand = parsed.kind === "message" ? { kind: "message", text: message.text } : parsed;
    if (await this.redirectProjectTopicMessageIfNeeded(context, message, preparedParsed, routed.conversation)) {
      return;
    }
    await this.recordIncomingMessage(state, context, message, preparedParsed);
    if (preparedParsed.kind === "help") {
      await this.handleHelpCommand(context, message);
      return;
    }
    if (preparedParsed.kind === "status") {
      await this.handleStatusCommand(state, context, message);
      return;
    }
    if (preparedParsed.kind === "project") {
      await this.handleProjectCommand(context, message, preparedParsed.name);
      return;
    }
    if (preparedParsed.kind === "stop") {
      await this.handleStopCommand(state, message);
      return;
    }
    if (preparedParsed.kind === "next") {
      await this.handleNextCommand(state, context, message);
      return;
    }
    if (preparedParsed.kind === "steer") {
      await this.handleSteerCommand(state, message);
      return;
    }
    if (preparedParsed.kind === "new") {
      await this.handleNewCommand(state, context, message);
      return;
    }
    if (preparedParsed.kind === "new_topic") {
      await this.handleNewTopicCommand(context, message);
      return;
    }
    if (preparedParsed.kind === "deactivate") {
      await this.handleDeactivateCommand(context, message);
      return;
    }
    if (preparedParsed.kind === "queue") {
      await this.handleQueueCommand(state, context, message, preparedParsed.text);
      return;
    }
    await this.handleUserMessage(state, context, message, preparedParsed.text);
  }

  private async recordIncomingMessage(
    state: ConversationState,
    context: MessageContext,
    message: IncomingLarkMessage,
    parsed: ParsedCommand
  ): Promise<void> {
    const role = roleForSender(this.options.config, message.senderOpenId);
    const route = classifyInitialRoute(state, parsed, message.text);
    const senderName = await this.resolveSenderName(context, message, role);
    message.senderName = senderName;
    await this.options.repository.insertLarkMessage({
      larkMessageId: message.messageId,
      eventId: message.eventId,
      larkUserId: message.senderOpenId,
      larkGroupId: message.larkGroupId,
      larkThreadId: message.larkThreadId,
      conversationKey: context.conversationKey,
      routeKind: route.routeKind,
      status: route.status,
      text: route.text,
      larkCreateTime: message.createTime,
      rawEventJson: safeJsonStringify(message.raw)
    });
  }

  private async redirectProjectTopicMessageIfNeeded(
    context: MessageContext,
    message: IncomingLarkMessage,
    parsed: ParsedCommand,
    conversation: ConversationRecord | null | undefined
  ): Promise<boolean> {
    if (conversation?.type !== "project" || !context.larkThreadId) {
      return false;
    }
    if (isTextOrPostMessage(message) && parsed.kind !== "message") {
      return false;
    }

    const existingThread = await this.options.repository.getCodexThreadByConversationAndLarkThread(
      context.conversationKey,
      context.larkThreadId
    );
    if (existingThread) {
      return false;
    }

    const chatId = nonEmptyString(message.larkGroupId) ?? nonEmptyString(message.chatId);
    if (!chatId) {
      throw new TwinnyError("Project topic message is missing chat_id", "LARK_MESSAGE_MALFORMED");
    }

    const topic = await this.createNewSessionTopic(context, {
      chatId,
      operatorOpenId: message.senderOpenId,
      eventId: message.eventId
    });
    if (!topic) {
      throw new TwinnyError("Project topic replacement was not created", "LARK_TOPIC_CREATE_FAILED");
    }

    const proxyMessageId = await this.sendProjectTopicProxyMessage(topic.cardMessageId, message);
    await this.replyProjectTopicRedirectNoticeBestEffort(message, topic.larkThreadId, context.larkThreadId);

    const proxyContext = createProjectTopicProxyContext(context, topic.larkThreadId);
    const proxyMessage = createProjectTopicProxyMessage(message, proxyMessageId, topic.larkThreadId);
    const proxyState = this.getState(proxyContext.stateKey);
    const proxyParsed: ParsedCommand = { kind: "message", text: proxyMessage.text };
    await this.recordIncomingMessage(proxyState, proxyContext, proxyMessage, proxyParsed);
    await this.handleUserMessage(proxyState, proxyContext, proxyMessage, proxyMessage.text);
    return true;
  }

  private async sendProjectTopicProxyMessage(
    anchorMessageId: string,
    message: IncomingLarkMessage
  ): Promise<string> {
    const result = await this.options.lark.replyRawMessage(anchorMessageId, rawMessageForLarkReply(message));
    const proxyMessageId = nonEmptyString(result?.messageId);
    if (!proxyMessageId) {
      throw new TwinnyError("Lark project topic proxy response did not include message_id", "LARK_MESSAGE_SEND_FAILED");
    }
    return proxyMessageId;
  }

  private async replyProjectTopicRedirectNoticeBestEffort(
    message: IncomingLarkMessage,
    agentThreadId: string,
    originalThreadId: string
  ): Promise<void> {
    try {
      await this.options.lark.replyText(message.messageId, "已创建 Agent 话题");
      await this.options.lark.forwardThreadToThread(agentThreadId, originalThreadId, {
        uuid: createLarkUuid("twinny-project-topic-forward", message.messageId, agentThreadId, originalThreadId)
      });
    } catch (error) {
      this.log.warn(
        { error, messageId: message.messageId, agentThreadId, originalThreadId },
        "failed to reply with project topic redirect notice"
      );
    }
  }

  private async prepareMessageResources(conversationKey: string, message: IncomingLarkMessage): Promise<void> {
    if ((message.resources?.length ?? 0) === 0) {
      return;
    }
    if (!this.options.larkFiles) {
      throw new TwinnyError("Lark file downloader is not configured", "LARK_FILE_DOWNLOADER_MISSING");
    }

    const workspace = await this.options.workspaces.ensureWorkspace(conversationKey);
    const outputDir = path.join(workspace, ".twinny", "lark_files", safePathSegment(message.messageId));
    const downloadedFiles = [];
    for (const resource of message.resources ?? []) {
      const downloaded = await this.options.larkFiles.downloadMessageResource({
        messageId: message.messageId,
        resourceType: resource.resourceType,
        fileKey: resource.fileKey,
        fileName: resource.fileName,
        outputDir
      });
      downloadedFiles.push({
        ...downloaded,
        codexTag: resource.codexTag,
        textPlaceholder: resource.textPlaceholder
      });
    }
    message.downloadedFiles = downloadedFiles;
    message.text = formatMessageTextWithDownloadedFiles(message.text, downloadedFiles, message.messageType);
  }

  private async applyGroupResponsePolicy(
    context: MessageContext,
    message: IncomingLarkMessage
  ): Promise<
    | { kind: "allow"; text: string; parsed: ParsedCommand; conversation?: ConversationRecord | null }
    | { kind: "ignored" }
    | { kind: "unauthorized" }
  > {
    const text = isGroupConversationType(context.type) ? stripBotMention(message.text, message, this.options.botOpenId) : message.text;
    const parsed = parseSlashCommand(text);
    if (!isGroupConversationType(context.type)) {
      return { kind: "allow", text, parsed };
    }

    const senderRole = roleForSender(this.options.config, message.senderOpenId);
    const hasBotMention = messageMentionsBot(message, this.options.botOpenId);
    const conversation = await this.options.repository.findByConversationKey(context.conversationKey);
    const isOwnerOnlyGroupCommand = parsed.kind === "activate" || parsed.kind === "new_topic";
    if (!conversation || conversation.responseMode === "none") {
      if (isOwnerOnlyGroupCommand && senderRole === "owner") {
        return { kind: "allow", text, parsed, conversation };
      }
      return hasBotMention ? { kind: "unauthorized" } : { kind: "ignored" };
    }

    if (
      conversation.responseMode === "at" &&
      !hasBotMention &&
      !(parsed.kind === "new_topic" && senderRole === "owner")
    ) {
      return { kind: "ignored" };
    }
    return { kind: "allow", text, parsed, conversation };
  }

  private async resolveSenderName(
    context: MessageContext,
    message: IncomingLarkMessage,
    role: RoleName
  ): Promise<string | undefined> {
    if (context.type === "p2p") {
      const conversation = await this.options.repository.findByConversationKey(context.conversationKey);
      const conversationName = nonEmptyString(conversation?.name);
      if (conversationName && conversationName !== message.senderOpenId) {
        return conversationName;
      }
    } else {
      const eventName = nonEmptyString(message.senderName);
      if (eventName) {
        return eventName;
      }
    }

    const failureUntil = this.nameLookupFailureCache.get(message.senderOpenId) ?? 0;
    if (failureUntil > Date.now()) {
      return undefined;
    }
    this.nameLookupFailureCache.delete(message.senderOpenId);

    if (!this.options.larkUsers) {
      return nonEmptyString(message.senderName);
    }

    try {
      const resolvedName = nonEmptyString(await this.options.larkUsers.getUserNameByOpenId(message.senderOpenId));
      if (!resolvedName) {
        this.cacheNameLookupFailure(message.senderOpenId);
        return undefined;
      }
      return resolvedName;
    } catch (error) {
      this.cacheNameLookupFailure(message.senderOpenId);
      this.log.warn({ error, larkUserId: message.senderOpenId }, "failed to resolve lark user name");
      return context.type === "p2p" ? undefined : nonEmptyString(message.senderName);
    }
  }

  private cacheNameLookupFailure(larkUserId: string): void {
    this.nameLookupFailureCache.set(larkUserId, Date.now() + (this.options.nameLookupFailureTtlMs ?? 60_000));
  }

  private async handleActivateCommand(
    state: ConversationState,
    context: MessageContext,
    message: IncomingLarkMessage,
    text: string
  ): Promise<void> {
    if (!isGroupConversationType(context.type)) {
      await this.recordIncomingMessage(state, context, message, { kind: "activate", text });
      await this.replyControlBestEffort(message.messageId, "activate 只支持群聊。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }

    const senderRole = roleForSender(this.options.config, message.senderOpenId);
    const existing = await this.options.repository.findByConversationKey(context.conversationKey);
    if (senderRole !== "owner") {
      if (existing && existing.responseMode !== "none") {
        await this.recordIncomingMessage(state, context, message, { kind: "activate", text });
        await this.replyControlBestEffort(message.messageId, "只有 owner 可以激活群聊。");
        await this.markMessagesCompletedBestEffort([message.messageId]);
      } else {
        await this.replyGroupUnauthorizedBestEffort(message.messageId);
      }
      return;
    }

    const parsed = parseActivateCommand(text);
    if (parsed.kind === "invalid") {
      await this.recordIncomingMessage(state, context, message, { kind: "activate", text });
      await this.replyControlBestEffort(message.messageId, parsed.message);
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }

    if (existing && parsed.role && existing.role !== parsed.role) {
      await this.recordIncomingMessage(state, context, message, { kind: "activate", text });
      await this.replyControlBestEffort(
        message.messageId,
        `该群已绑定 role=${existing.role}，本期不支持修改为 ${parsed.role}。`
      );
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }

    const role = parsed.role ?? existing?.role ?? "guest";
    const groupInfo = await this.resolveGroupInfo(message, existing);
    if (existing) {
      await this.options.repository.updateConversationSettings(context.conversationKey, {
        name: groupInfo.name,
        chatMode: groupInfo.chatMode,
        responseMode: parsed.responseMode
      });
    } else {
      const workspace = await this.options.workspaces.ensureWorkspace(context.conversationKey);
      const thread = await this.options.codex.startThread({
        role,
        cwd: workspace,
        approvalPolicy: "never"
      });
      await this.options.repository.create({
        conversationKey: context.conversationKey,
        type: context.type,
        chatId: message.chatId,
        name: groupInfo.name,
        chatMode: groupInfo.chatMode,
        responseMode: parsed.responseMode,
        role,
        codexThreadId: thread.threadId,
        workspace,
        roleCodexHome: this.options.roles.codexHomeFor(role)
      });
      await this.recordCodexThreadBestEffort({
        conversationKey: context.conversationKey,
        codexThreadId: thread.threadId,
        role,
        codexThreadHasRollout: false
      });
    }

    await this.recordIncomingMessage(state, context, message, { kind: "activate", text });
    await this.replyControlBestEffort(
      message.messageId,
      [
        `已激活群聊：${groupInfo.name}`,
        `响应模式：${parsed.responseMode}`,
        `Role：${role}`
      ].filter(Boolean).join("\n")
    );
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async resolveGroupInfo(
    message: IncomingLarkMessage,
    existing?: ConversationRecord | null
  ): Promise<{ name: string; chatMode?: LarkChatMode; groupMessageType?: LarkGroupMessageType }> {
    let resolvedChatMode: LarkChatMode | undefined;
    let resolvedGroupMessageType: LarkGroupMessageType | undefined;
    if (this.options.larkChats?.getChatInfo) {
      try {
        const info = await this.options.larkChats.getChatInfo(message.chatId);
        resolvedChatMode = info?.chatMode;
        resolvedGroupMessageType = info?.groupMessageType;
        const resolvedName = nonEmptyString(info?.name);
        if (resolvedName) {
          return {
            name: resolvedName,
            chatMode: resolvedChatMode ?? existing?.chatMode,
            groupMessageType: resolvedGroupMessageType
          };
        }
      } catch (error) {
        this.log.warn({ error, chatId: message.chatId }, "failed to resolve lark chat info");
      }
    } else {
      try {
        const resolved = nonEmptyString(await this.options.larkChats?.getChatName?.(message.chatId));
        if (resolved) {
          return { name: resolved, chatMode: existing?.chatMode };
        }
      } catch (error) {
        this.log.warn({ error, chatId: message.chatId }, "failed to resolve lark chat name");
      }
    }

    return {
      name: nonEmptyString(message.chatName) ?? nonEmptyString(existing?.name) ?? message.chatId,
      chatMode: resolvedChatMode ?? existing?.chatMode,
      groupMessageType: resolvedGroupMessageType
    };
  }

  private async handleProjectCommand(
    _context: MessageContext,
    message: IncomingLarkMessage,
    projectName: string
  ): Promise<void> {
    if (roleForSender(this.options.config, message.senderOpenId) !== "owner") {
      await this.replyControlBestEffort(message.messageId, "只有 owner 可以创建 project 群。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }
    const projectDisplayName = projectName.trim();
    if (!projectDisplayName) {
      await this.replyControlBestEffort(message.messageId, "用法：/project <name>");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }
    if (!this.options.larkChats?.createChat) {
      await this.replyControlBestEffort(message.messageId, "Lark 群创建能力未配置。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }

    const created = await this.options.larkChats.createChat({
      name: projectDisplayName,
      ownerOpenId: this.options.config.owner.openId,
      userOpenIds: [this.options.config.owner.openId],
      groupMessageType: "thread",
      setBotManager: true,
      uuid: createLarkUuid("twinny-project", message.messageId)
    });
    const chatId = nonEmptyString(created.chatId);
    if (!chatId) {
      throw new TwinnyError("Lark create chat response did not include chat_id", "LARK_CHAT_CREATE_FAILED");
    }

    const conversationKey = conversationKeyForGroup(chatId);
    const existing = await this.options.repository.findByConversationKey(conversationKey);
    const workspace = existing?.workspace ?? await this.options.workspaces.ensureWorkspace(conversationKey);
    const role: RoleName = "owner";
    const thread = await this.options.codex.startThread({
      role,
      cwd: workspace,
      approvalPolicy: "never"
    });
    if (existing) {
      await this.options.repository.updateConversationSettings(conversationKey, {
        type: "project",
        name: projectDisplayName,
        chatMode: "group",
        responseMode: "all"
      });
      await this.options.repository.updateThreadBinding(conversationKey, {
        codexThreadId: thread.threadId,
        role,
        roleCodexHome: this.options.roles.codexHomeFor(role),
        workspace
      });
    } else {
      await this.options.repository.create({
        conversationKey,
        type: "project",
        chatId,
        name: projectDisplayName,
        chatMode: "group",
        responseMode: "all",
        role,
        codexThreadId: thread.threadId,
        workspace,
        roleCodexHome: this.options.roles.codexHomeFor(role)
      });
    }
    await this.recordCodexThreadBestEffort({
      conversationKey,
      codexThreadId: thread.threadId,
      role,
      codexThreadHasRollout: false
    });
    await this.replyControlBestEffort(
      message.messageId,
      [
        `已创建 project 群：${projectDisplayName}`,
        `Project：${projectDisplayName}`,
        "消息模式：话题",
        `Conversation Key：${conversationKey}`,
        `Codex Thread ID：${thread.threadId}`
      ].filter(Boolean).join("\n")
    );
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async handleNewSessionMenuAction(
    context: MessageContext,
    action: IncomingLarkBotMenuAction
  ): Promise<void> {
    if (!action.chatId || !isGroupConversationType(context.type)) {
      await this.sendDirectControlBestEffort(action.operatorOpenId, "新会话菜单只能在群聊中使用。");
      return;
    }
    await this.createNewSessionTopic(context, {
      chatId: action.chatId,
      operatorOpenId: action.operatorOpenId,
      eventId: action.eventId
    });
  }

  private async handleNewTopicCommand(context: MessageContext, message: IncomingLarkMessage): Promise<void> {
    if (!isGroupConversationType(context.type)) {
      await this.replyControlBestEffort(message.messageId, "new_topic 只能在群里用。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }
    if (roleForSender(this.options.config, message.senderOpenId) !== "owner") {
      await this.replyControlBestEffort(message.messageId, "只有 owner 可以创建新话题。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }
    const chatId = nonEmptyString(message.larkGroupId) ?? nonEmptyString(message.chatId);
    if (!chatId) {
      await this.replyControlBestEffort(message.messageId, "new_topic 只能在群里用。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }
    await this.createNewSessionTopic(context, {
      chatId,
      operatorOpenId: message.senderOpenId,
      eventId: message.eventId
    });
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async createNewSessionTopic(
    context: MessageContext,
    request: NewSessionTopicRequest
  ): Promise<CreatedSessionTopic | undefined> {
    const conversation = await this.options.repository.findByConversationKey(context.conversationKey);
    if (!conversation || conversation.responseMode === "none") {
      await this.sendDirectControlBestEffort(request.operatorOpenId, "请先由 owner 在群内执行 /activate。");
      return;
    }

    const role = conversation.role;
    const workspace = conversation.workspace;
    const thread = await this.options.codex.startThread({
      role,
      cwd: workspace,
      approvalPolicy: "never"
    });
    await this.options.repository.upsertCodexThread({
      conversationKey: context.conversationKey,
      codexThreadId: thread.threadId,
      role,
      codexThreadHasRollout: false
    });
    const initialRecord = await this.options.repository.updateCodexThreadCard({
      conversationKey: context.conversationKey,
      codexThreadId: thread.threadId,
      role,
      creatorOpenId: request.operatorOpenId
    });
    const result = await this.options.lark.sendCardToChatId(
      request.chatId,
      await this.renderThreadSummaryCard(initialRecord),
      { uuid: createLarkUuid("twinny-new-session", request.eventId) }
    );
    const cardMessageId = nonEmptyString(result?.messageId);
    if (!cardMessageId) {
      throw new TwinnyError("Lark new-session card response did not include message_id", "LARK_MESSAGE_SEND_FAILED");
    }
    const cardThreadId = extractLarkMessageThreadId(result?.raw) ?? cardMessageId;
    await this.options.repository.updateCodexThreadCard({
      conversationKey: context.conversationKey,
      codexThreadId: thread.threadId,
      role,
      larkThreadId: cardThreadId,
      creatorOpenId: request.operatorOpenId,
      cardMessageId
    });
    return {
      codexThreadId: thread.threadId,
      larkThreadId: cardThreadId,
      cardMessageId
    };
  }

  private async handleDeactivateCommand(context: MessageContext, message: IncomingLarkMessage): Promise<void> {
    if (!isGroupConversationType(context.type)) {
      await this.replyControlBestEffort(message.messageId, "deactivate 只支持群聊。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }
    if (roleForSender(this.options.config, message.senderOpenId) !== "owner") {
      await this.replyControlBestEffort(message.messageId, "只有 owner 可以停用群聊。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }

    await this.options.repository.updateConversationSettings(context.conversationKey, { responseMode: "none" });
    const cleared = await this.cancelConversationStates(context.conversationKey);
    await this.replyControlBestEffort(message.messageId, `已停用该群，清空 ${cleared} 条待处理消息。`);
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async cancelConversationStates(conversationKey: string): Promise<number> {
    let cleared = 0;
    for (const [stateKey, state] of this.states) {
      if (stateKey !== conversationKey && !stateKey.startsWith(`${conversationKey}_thread_`)) {
        continue;
      }
      const clearedMessages = await this.clearPendingMessagesBestEffort(state);
      cleared += clearedMessages.length;
      await this.markPendingMessagesClearedBestEffort(clearedMessages);
      await this.cancelActiveTurn(state);
    }
    return cleared;
  }

  private async handleUserMessage(
    state: ConversationState,
    context: MessageContext,
    message: IncomingLarkMessage,
    text: string
  ): Promise<void> {
    const queueByMenu = state.queueNextMessage;
    if (queueByMenu) {
      state.queueNextMessage = false;
    }
    const pending = toPendingMessage(message, text, { queueBoundary: queueByMenu });
    const active = state.active;
    if (queueByMenu) {
      if (active || state.pendingBatch.length > 0) {
        await this.addQueuedReactionBestEffort(pending);
      }
      state.pendingBatch.push(pending);
      if (!active) {
        await this.startPendingBatch(state, context);
      }
      return;
    }
    if (state.pendingBatch.length > 0 || active?.cancelRequested) {
      await this.addQueuedReactionBestEffort(pending);
      state.pendingBatch.push(pending);
      if (!active) {
        await this.startPendingBatch(state, context);
      }
      return;
    }

    if (active) {
      await this.steerOrDefer(state, active, pending);
      return;
    }

    await this.startTurnForMessages(state, context, [pending]);
  }

  private async handleQueueCommand(
    state: ConversationState,
    context: MessageContext,
    message: IncomingLarkMessage,
    text: string
  ): Promise<void> {
    if (!text) {
      await this.replyControlBestEffort(message.messageId, "用法：/queue <message>");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }

    state.queueNextMessage = false;
    const pending = toPendingMessage(message, text, { queueBoundary: true });
    if (state.active || state.pendingBatch.length > 0) {
      await this.addQueuedReactionBestEffort(pending);
    }
    state.pendingBatch.push(pending);
    if (!state.active) {
      await this.startPendingBatch(state, context);
    }
  }

  private async handleHelpCommand(context: MessageContext, message: IncomingLarkMessage): Promise<void> {
    await this.replyControlBestEffort(message.messageId, helpTextFor(message, context, this.options.config));
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async handleStatusCommand(
    state: ConversationState,
    context: MessageContext,
    message: IncomingLarkMessage
  ): Promise<void> {
    await this.replyControlBestEffort(
      message.messageId,
      await this.formatStatusText(state, context, {
        senderOpenId: message.senderOpenId,
        senderName: message.senderName,
        chatId: message.chatId,
        chatName: message.chatName
      })
    );
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async formatStatusText(
    state: ConversationState,
    context: MessageContext,
    actor: ConversationActor
  ): Promise<string> {
    const role = roleForSender(this.options.config, actor.senderOpenId);
    const conversation = await this.options.repository.findByConversationKey(context.conversationKey);
    const topicThread = context.larkThreadId
      ? await this.options.repository.getCodexThreadByConversationAndLarkThread(context.conversationKey, context.larkThreadId)
      : undefined;
    const threadId = state.active?.threadId ?? topicThread?.codexThreadId ?? conversation?.codexThreadId;
    const thread = threadId ? await this.options.repository.getCodexThreadById(threadId) : undefined;
    const lines = [
      `OUID: ${actor.senderOpenId}`,
      `Conversation Key: ${context.conversationKey}`
    ];

    if (isGroupConversationType(context.type)) {
      lines.push(
        `Chat Name: ${conversation?.name ?? actor.chatName ?? actor.chatId ?? context.conversationKey}`,
        `Response Mode: ${conversation?.responseMode ?? "none"}`,
        `Role: ${conversation?.role ?? "未创建"}`,
        `Workspace: ${conversation?.workspace ?? "未创建"}`
      );
      if (context.larkThreadId) {
        lines.push(`Lark Thread ID: ${context.larkThreadId}`);
      }
    }

    lines.push(`Codex Thread ID: ${threadId ?? "未创建"}`, ...formatThreadTokenStatus(thread));

    if (role === "owner") {
      lines.push(...(await this.formatOwnerRateLimitStatus(role)));
    }

    return lines.join("\n");
  }

  private async formatOwnerRateLimitStatus(role: RoleName): Promise<string[]> {
    if (!this.options.codex.readAccountRateLimits) {
      return ["Codex Account Usage: unavailable"];
    }
    try {
      const usage = await this.options.codex.readAccountRateLimits({ role });
      return formatAccountRateLimitStatus(usage);
    } catch (error) {
      this.log.warn({ error, role }, "failed to read codex account rate limits");
      return ["Codex Account Usage: unavailable"];
    }
  }

  private async handleStopCommand(state: ConversationState, message: IncomingLarkMessage): Promise<void> {
    const { cleared, interrupted } = await this.stopConversationState(state);
    const summary = interrupted
      ? `已停止当前任务，清空 ${cleared} 条待处理消息。`
      : `当前没有正在运行的任务，清空 ${cleared} 条待处理消息。`;
    await this.replyControlBestEffort(message.messageId, summary);
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async stopConversationState(state: ConversationState): Promise<{ cleared: number; interrupted: boolean }> {
    state.queueNextMessage = false;
    const clearedMessages = await this.clearPendingMessagesBestEffort(state);
    await this.markPendingMessagesClearedBestEffort(clearedMessages);
    return {
      cleared: clearedMessages.length,
      interrupted: await this.cancelActiveTurn(state)
    };
  }

  private async processCardAction(
    state: ConversationState,
    action: IncomingLarkCardAction,
    command: ParsedCardActionCommand
  ): Promise<void> {
    const existing = await this.options.repository.getLarkMessageByEventId(action.eventId);
    if (existing) {
      return;
    }

    const active = state.active;
    let status: LarkMessageStatus = "completed";
    try {
      const stale =
        !active ||
        active.runId !== command.runId ||
        active.context.stateKey !== command.stateKey ||
        (action.openMessageId !== undefined && active.card?.messageId !== undefined && action.openMessageId !== active.card.messageId);
      if (!stale) {
        switch (command.action) {
          case "stop":
            await this.executeStopAction(state);
            break;
          case "next":
            await this.executeNextAction(state, active.context);
            break;
          case "queue":
            await this.executeQueueAction(state, active);
            break;
        }
      }
    } catch (error) {
      status = "failed";
      throw error;
    } finally {
      await this.recordCardActionBestEffort(action, command, status, active);
    }
  }

  private async executeStopAction(state: ConversationState): Promise<void> {
    await this.stopConversationState(state);
  }

  private async executeNextAction(state: ConversationState, context: MessageContext): Promise<void> {
    const interrupted = await this.cancelActiveTurn(state, { waitForCompletion: true });
    if (!interrupted) {
      await this.startPendingBatch(state, context);
    }
  }

  private async executeQueueAction(state: ConversationState, active: ActiveTurn): Promise<void> {
    state.queueNextMessage = !state.queueNextMessage;
    await this.patchAgentCardBestEffort(state, active, "working");
  }

  private async recordMenuActionBestEffort(
    action: IncomingLarkBotMenuAction,
    context: MessageContext,
    status: LarkMessageStatus,
    active?: ActiveTurn
  ): Promise<void> {
    try {
      await this.options.repository.insertLarkMessage({
        eventId: action.eventId,
        larkUserId: action.operatorOpenId,
        larkGroupId: action.chatId,
        larkThreadId: active?.context.larkThreadId,
        conversationKey: context.conversationKey,
        codexThreadId: active?.threadId,
        codexTurnId: active?.turnId,
        routeKind: "menu_action",
        status,
        text: action.eventKey,
        rawEventJson: safeJsonStringify(action.raw)
      });
    } catch (error) {
      this.log.warn({ error, eventId: action.eventId }, "failed to record menu action message");
    }
  }

  private async recordCardActionBestEffort(
    action: IncomingLarkCardAction,
    command: ParsedCardActionCommand,
    status: LarkMessageStatus,
    active?: ActiveTurn
  ): Promise<void> {
    try {
      await this.options.repository.insertLarkMessage({
        eventId: action.eventId,
        larkUserId: action.operatorOpenId,
        larkGroupId: action.openChatId,
        larkThreadId: active?.context.larkThreadId,
        conversationKey: active?.conversationKey ?? conversationKeyFromStateKey(command.stateKey),
        codexThreadId: active?.threadId,
        codexTurnId: active?.turnId,
        routeKind: "card_action",
        status,
        text: command.text,
        rawEventJson: safeJsonStringify(action.raw)
      });
    } catch (error) {
      this.log.warn({ error, eventId: action.eventId }, "failed to record card action message");
    }
  }

  private async handleNextCommand(
    state: ConversationState,
    context: MessageContext,
    message: IncomingLarkMessage
  ): Promise<void> {
    const queued = state.pendingBatch.length;
    const nextBatchSize = countNextPendingBatch(state);
    const interrupted = await this.cancelActiveTurn(state, { waitForCompletion: true });
    if (!interrupted) {
      await this.startPendingBatch(state, context);
    }
    const summary = interrupted
      ? queued > 0
        ? `已打断当前任务，将执行队列中的下一条消息。队列剩余 ${Math.max(queued - nextBatchSize, 0)} 条。`
        : "已打断当前任务，但队列为空。"
      : queued > 0
        ? `当前没有正在运行的任务，开始执行队列中的下一条消息。队列剩余 ${Math.max(queued - nextBatchSize, 0)} 条。`
        : "当前没有正在运行的任务，队列为空。";
    await this.replyControlBestEffort(message.messageId, summary);
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async handleSteerCommand(state: ConversationState, message: IncomingLarkMessage): Promise<void> {
    const nextBatchSize = countNextPendingBatch(state);
    if (nextBatchSize === 0) {
      await this.replyControlBestEffort(message.messageId, "队列为空。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }

    const active = state.active;
    if (!active || active.cancelRequested || !active.turnId || active.completedStatus) {
      await this.replyControlBestEffort(message.messageId, "当前没有可注入的运行任务，队列保持不变。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }

    const batch = state.pendingBatch.slice(0, nextBatchSize);
    const input = batch.map(formatPendingMessageForCodex).join("\n");
    try {
      await this.options.codex.steerTurn({
        role: active.role,
        threadId: active.threadId,
        turnId: active.turnId,
        input,
        cwd: active.workspace,
        approvalPolicy: "never"
      });
    } catch (error) {
      this.log.warn(
        { error, threadId: active.threadId, turnId: active.turnId, messageId: message.messageId },
        "failed to steer queued messages into active codex turn"
      );
      await this.replyControlBestEffort(message.messageId, "注入当前任务失败，队列保持不变。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }

    if (state.active !== active || active.cancelRequested || active.completedStatus) {
      await this.replyControlBestEffort(message.messageId, "当前任务已结束，队列保持不变。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }

    state.pendingBatch.splice(0, nextBatchSize);
    await this.clearQueuedReactionsBestEffort(batch);
    await this.markActiveProcessingMessagesSteered(active);
    const messageIds = batch.map((queued) => queued.messageId);
    for (const queued of batch) {
      active.messagesById.set(queued.messageId, queued);
      active.messageIds.add(queued.messageId);
      active.processingMessageIds.add(queued.messageId);
    }
    await this.markMessagesProcessingBestEffort(messageIds, {
      conversationKey: active.conversationKey,
      codexThreadId: active.threadId,
      codexTurnId: active.turnId
    });
    const anchor = batch[batch.length - 1]!;
    active.replyMessageId = anchor.messageId;
    await this.moveReactionBestEffort(active, anchor.messageId);
    await this.moveAgentCardBestEffort(state, active, anchor.messageId);
    await this.replyControlBestEffort(
      message.messageId,
      `已将队列中的 ${nextBatchSize} 条消息注入当前任务。队列剩余 ${state.pendingBatch.length} 条。`
    );
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async handleNewCommand(
    state: ConversationState,
    context: MessageContext,
    message: IncomingLarkMessage
  ): Promise<void> {
    if (context.larkThreadId) {
      await this.replyControlBestEffort(message.messageId, "不能在话题内创建新的 Thread。");
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }

    const threadId = await this.openNewThreadForMessage(state, context, message);
    await this.replyControlBestEffort(message.messageId, `已新开 Codex thread：${threadId}`);
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async openNewThreadForMessage(
    state: ConversationState,
    context: MessageContext,
    message: IncomingLarkMessage
  ): Promise<string> {
    state.queueNextMessage = false;
    await this.markPendingMessagesClearedBestEffort(await this.clearPendingMessagesBestEffort(state));
    await this.cancelActiveTurn(state);
    const existing = await this.options.repository.findByConversationKey(context.conversationKey);
    const role = existing?.role ?? roleForSender(this.options.config, message.senderOpenId);
    const workspace = await this.options.workspaces.ensureWorkspace(context.conversationKey);
    const thread = await this.options.codex.startThread({
      role,
      cwd: workspace,
      approvalPolicy: "never"
    });

    if (context.larkThreadId) {
      await this.recordOrReplaceCodexThreadBestEffort({
        conversationKey: context.conversationKey,
        codexThreadId: thread.threadId,
        role,
        larkThreadId: context.larkThreadId,
        codexThreadHasRollout: false,
        replaceExistingLarkThread: true
      });
    } else if (existing) {
      await this.options.repository.updateThreadBinding(context.conversationKey, {
        codexThreadId: thread.threadId,
        role,
        roleCodexHome: this.options.roles.codexHomeFor(role),
        workspace
      });
    } else {
      await this.options.repository.create({
        conversationKey: context.conversationKey,
        type: context.type,
        chatId: context.type === "p2p" ? message.senderOpenId : message.chatId,
        name: conversationNameForMessage(this.options.config, role, message),
        responseMode: context.type === "p2p" ? "all" : "at",
        role,
        codexThreadId: thread.threadId,
        workspace,
        roleCodexHome: this.options.roles.codexHomeFor(role)
      });
    }
    if (!context.larkThreadId) {
      await this.recordCodexThreadBestEffort({
        conversationKey: context.conversationKey,
        codexThreadId: thread.threadId,
        role,
        codexThreadHasRollout: false
      });
    }
    return thread.threadId;
  }

  private async steerOrDefer(
    state: ConversationState,
    active: ActiveTurn,
    message: PendingMessage
  ): Promise<void> {
    if (!active.turnId) {
      await this.markActiveProcessingMessagesSteered(active);
      active.pendingSteers.push(message);
      active.messagesById.set(message.messageId, message);
      active.messageIds.add(message.messageId);
      active.processingMessageIds.add(message.messageId);
      await this.markMessagesProcessingBestEffort([message.messageId], {
        conversationKey: active.conversationKey,
        codexThreadId: active.threadId
      });
      active.replyMessageId = message.messageId;
      await this.moveReactionBestEffort(active, message.messageId);
      await this.moveAgentCardBestEffort(state, active, message.messageId);
      return;
    }

    try {
      await this.options.codex.steerTurn({
        role: active.role,
        threadId: active.threadId,
        turnId: active.turnId,
        input: formatPendingMessageForCodex(message),
        cwd: active.workspace,
        approvalPolicy: "never"
      });
      await this.markActiveProcessingMessagesSteered(active);
      active.messagesById.set(message.messageId, message);
      active.messageIds.add(message.messageId);
      active.processingMessageIds.add(message.messageId);
      await this.markMessagesProcessingBestEffort([message.messageId], {
        conversationKey: active.conversationKey,
        codexThreadId: active.threadId,
        codexTurnId: active.turnId
      });
      active.replyMessageId = message.messageId;
      await this.moveReactionBestEffort(active, message.messageId);
      await this.moveAgentCardBestEffort(state, active, message.messageId);
    } catch (error) {
      this.log.warn(
        { error, threadId: active.threadId, turnId: active.turnId, messageId: message.messageId },
        "failed to steer active codex turn; queueing message for next turn"
      );
      await this.addQueuedReactionBestEffort(message);
      state.pendingBatch.push(message);
      await this.markPendingMessagesQueuedBestEffort([message]);
      await this.replyControlBestEffort(message.messageId, "当前任务已不可打断注入，已加入下一轮队列。");
    }
  }

  private async startPendingBatch(state: ConversationState, context: MessageContext): Promise<void> {
    while (!state.active && state.pendingBatch.length > 0) {
      const count = countNextPendingBatch(state);
      const messages = state.pendingBatch.splice(0, count);
      await this.clearQueuedReactionsBestEffort(messages);
      const refreshedMessages = await this.refreshPendingMessagesBeforeStart(context, messages);
      if (refreshedMessages.length === 0) {
        continue;
      }
      await this.startTurnForMessages(state, context, refreshedMessages);
      return;
    }
  }

  private async refreshPendingMessagesBeforeStart(context: MessageContext, messages: PendingMessage[]): Promise<PendingMessage[]> {
    if (!this.options.larkMessages || messages.length === 0) {
      return messages;
    }
    const refreshed = await Promise.all(messages.map((message) => this.refreshPendingMessageBeforeStart(context, message)));
    return refreshed.filter((message): message is PendingMessage => message !== undefined);
  }

  private async refreshPendingMessageBeforeStart(
    context: MessageContext,
    pending: PendingMessage
  ): Promise<PendingMessage | undefined> {
    const reader = this.options.larkMessages;
    if (!reader) {
      return pending;
    }

    let fetchedRaw: unknown;
    try {
      fetchedRaw = await reader.getMessage(pending.messageId);
    } catch (error) {
      if (isLarkMessageUnavailableError(error)) {
        this.log.info({ messageId: pending.messageId }, "queued Lark message unavailable before processing; marking recalled");
        await this.markMessageRecalledBestEffort(pending.messageId);
        return undefined;
      }
      this.log.warn({ error, messageId: pending.messageId }, "failed to refresh queued Lark message; using stored content");
      return pending;
    }

    try {
      const latestRaw = patchLarkMessageRawEvent(pending.original.raw, fetchedRaw);
      if (!larkMessageContentChanged(pending.original.raw, latestRaw)) {
        return pending;
      }

      const normalized = normalizeIncomingLarkMessage(latestRaw, { botOpenId: this.options.botOpenId });
      if (!normalized || normalized.messageId !== pending.messageId) {
        this.log.warn(
          { messageId: pending.messageId },
          "refreshed queued Lark message could not be normalized; using stored content"
        );
        return pending;
      }

      normalized.senderName = await this.resolveSenderName(
        context,
        normalized,
        roleForSender(this.options.config, normalized.senderOpenId)
      );
      const parsed = parseSlashCommand(normalized.text);
      const text = parsed.kind === "queue" ? parsed.text : normalized.text;
      await this.prepareMessageResources(context.conversationKey, normalized);
      pending.original = normalized;
      pending.text = (normalized.downloadedFiles?.length ?? 0) > 0 ? normalized.text : text;
      await this.updateQueuedMessageBestEffort(pending.messageId, {
        text: pending.text,
        rawEventJson: safeJsonStringify(latestRaw)
      });
    } catch (error) {
      this.log.warn({ error, messageId: pending.messageId }, "failed to apply refreshed Lark message; using stored content");
    }
    return pending;
  }

  private async startTurnForMessages(
    state: ConversationState,
    context: MessageContext,
    messages: PendingMessage[]
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const anchor = messages[messages.length - 1]!;
    const senderRole = roleForSender(this.options.config, anchor.original.senderOpenId);
    const workspace = await this.options.workspaces.ensureWorkspace(context.conversationKey);
    const binding = await this.getOrCreateConversation({
      conversationKey: context.conversationKey,
      type: context.type,
      role: senderRole,
      workspace,
      message: anchor.original
    });
    const role = binding.conversation.role;
    const activeThread = await this.resolveActiveThread(binding, {
      role,
      workspace,
      context
    });
    if (activeThread.replacedMissingThread) {
      await this.notifyThreadReplacementBestEffort(anchor.messageId, activeThread.previousThreadId, activeThread.threadId);
    }
    await this.recordCodexThreadBestEffort({
      conversationKey: context.conversationKey,
      codexThreadId: activeThread.threadId,
      role,
      larkThreadId: context.larkThreadId
    });
    await this.beginActiveTurn(state, context, {
      messages,
      role,
      threadId: activeThread.threadId,
      workspace,
      input: messages.map(formatPendingMessageForCodex).join("\n")
    });
  }

  private async beginActiveTurn(
    state: ConversationState,
    context: MessageContext,
    params: {
      messages: PendingMessage[];
      role: RoleName;
      threadId: string;
      workspace: string;
      input: string;
    }
  ): Promise<void> {
    if (params.messages.length === 0) {
      return;
    }
    const anchor = params.messages[params.messages.length - 1]!;
    await this.markPendingMessagesProcessingBestEffort(params.messages, {
      conversationKey: context.conversationKey,
      codexThreadId: params.threadId
    });
    const startedAt = Date.now();
    const agentMessageMode = this.options.config.lark.agentMessageMode;
    const active: ActiveTurn = {
      runId: ++state.nextRunId,
      agentMessageMode,
      role: params.role,
      threadId: params.threadId,
      workspace: params.workspace,
      conversationKey: context.conversationKey,
      context,
      replyMessageId: anchor.messageId,
      startedAt,
      reaction: await this.addReactionBestEffort(anchor.messageId),
      card:
        agentMessageMode === "card"
          ? {
              anchorMessageId: anchor.messageId,
              startedAt,
              messages: [],
              fallbackPlain: false
            }
          : undefined,
      pendingSteers: [],
      messagesById: new Map(params.messages.map((message) => [message.messageId, message])),
      messageIds: new Set(params.messages.map((message) => message.messageId)),
      processingMessageIds: new Set(params.messages.map((message) => message.messageId)),
      steeredMessageIds: new Set(),
      cancelRequested: false
    };
    state.active = active;

    const turnPromise = this.options.codex.startTurn({
      role: params.role,
      threadId: active.threadId,
      input: params.input,
      cwd: params.workspace,
      approvalPolicy: "never",
      onTurnStarted: (turnId) => this.handleTurnStarted(state, active, turnId),
      onAgentMessage: (agentMessage) => this.replyAgentMessageForActiveBestEffort(state, active, agentMessage),
      onTokenUsage: (usage) => this.recordThreadTokenUsageBestEffort(active, usage)
    });
    void turnPromise
      .then((result) => {
        active.completedStatus = result.status;
        active.resultText = result.text;
        active.resultError = result.error;
        this.log.info(
          {
            messageId: anchor.messageId,
            conversationKey: context.conversationKey,
            role: params.role,
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
          await this.markMessagesFailedBestEffort([...active.processingMessageIds]);
          this.log.error({ error, messageId: active.replyMessageId, conversationKey: context.conversationKey }, "conversation turn failed");
          await this.failAgentCardBestEffort(state, active, toErrorMessage(error));
          if (active.agentMessageMode !== "card" || active.card?.fallbackPlain || !active.card?.messageId) {
            await this.replyErrorBestEffort(active.replyMessageId, error);
          }
        } else {
          this.log.debug({ error, conversationKey: context.conversationKey, threadId: active.threadId }, "ignored stale codex turn failure");
        }
      })
      .finally(() => {
        void state.controlQueue.enqueue(() => this.finishActiveTurn(state, context.conversationKey, active));
      });
    await this.createAgentCardBestEffort(state, active);
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
      await this.markMessagesProcessingBestEffort([...active.processingMessageIds], {
        conversationKey: active.conversationKey,
        codexThreadId: active.threadId,
        codexTurnId: turnId
      });
      await this.markMessagesSteeredBestEffort([...active.steeredMessageIds], {
        conversationKey: active.conversationKey,
        codexThreadId: active.threadId,
        codexTurnId: turnId
      });
      await this.updateThreadSummaryCardBestEffort(active.threadId);
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
        const remaining = pending.slice(index);
        for (const message of remaining) {
          active.messagesById.delete(message.messageId);
          active.messageIds.delete(message.messageId);
          active.processingMessageIds.delete(message.messageId);
          active.steeredMessageIds.delete(message.messageId);
        }
        await this.addQueuedReactionsBestEffort(remaining);
        state.pendingBatch.unshift(...remaining);
        await this.markPendingMessagesQueuedBestEffort(remaining);
        return;
      }
      const message = pending[index]!;
      try {
        await this.options.codex.steerTurn({
          role: active.role,
          threadId: active.threadId,
          turnId: active.turnId,
          input: formatPendingMessageForCodex(message),
          cwd: active.workspace,
          approvalPolicy: "never"
        });
        const update = {
          conversationKey: active.conversationKey,
          codexThreadId: active.threadId,
          codexTurnId: active.turnId
        };
        if (active.processingMessageIds.has(message.messageId)) {
          await this.markMessagesProcessingBestEffort([message.messageId], update);
        } else {
          await this.markMessagesSteeredBestEffort([message.messageId], update);
        }
      } catch (error) {
        this.log.warn(
          { error, threadId: active.threadId, turnId: active.turnId, messageId: message.messageId },
          "failed to flush pending steer messages; queueing remaining messages"
        );
        const remaining = pending.slice(index);
        for (const queued of remaining) {
          active.messagesById.delete(queued.messageId);
          active.messageIds.delete(queued.messageId);
          active.processingMessageIds.delete(queued.messageId);
          active.steeredMessageIds.delete(queued.messageId);
        }
        await this.addQueuedReactionsBestEffort(remaining);
        state.pendingBatch.unshift(...remaining);
        await this.markPendingMessagesQueuedBestEffort(remaining);
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
      this.stopAgentCardTimer(active);
      return;
    }
    state.active = undefined;
    await this.clearReactionBestEffort(active);
    if (active.cancelRequested) {
      this.stopAgentCardTimer(active);
      await this.startPendingBatch(state, active.context);
      return;
    }
    if (active.completedStatus === "completed") {
      await this.markMessagesCompletedBestEffort([...active.processingMessageIds]);
      await this.completeAgentCardBestEffort(state, active);
    } else {
      await this.markMessagesFailedBestEffort([...active.processingMessageIds]);
      await this.failAgentCardBestEffort(state, active, active.resultError ?? "Codex turn failed");
    }
    await this.addCompletedReactionBestEffort(active);
    await this.updateThreadSummaryCardBestEffort(active.threadId);
    this.stopAgentCardTimer(active);
    await this.startPendingBatch(state, active.context);
  }

  private clearPendingMessages(state: ConversationState): PendingMessage[] {
    const batchPending = state.pendingBatch.splice(0);
    return batchPending;
  }

  private async clearPendingMessagesBestEffort(state: ConversationState): Promise<PendingMessage[]> {
    const batchPending = this.clearPendingMessages(state);
    await this.clearQueuedReactionsBestEffort(batchPending);
    return batchPending;
  }

  private async cancelActiveTurn(
    state: ConversationState,
    options: { waitForCompletion?: boolean } = {}
  ): Promise<boolean> {
    const active = state.active;
    if (!active) {
      return false;
    }
    if (!options.waitForCompletion) {
      state.active = undefined;
    }
    active.cancelRequested = true;
    active.pendingSteers = [];
    await this.clearReactionBestEffort(active);
    await this.markMessagesInterruptedBestEffort([...active.processingMessageIds]);
    await this.updateThreadSummaryCardBestEffort(active.threadId);
    await this.interruptAgentCardBestEffort(state, active);
    if (active.turnId) {
      await this.interruptActiveTurnBestEffort(active);
    }
    return true;
  }

  private async suspendActiveTurnForShutdown(state: ConversationState): Promise<boolean> {
    const active = state.active;
    if (!active) {
      return false;
    }
    state.active = undefined;
    active.cancelRequested = true;
    active.pendingSteers = [];
    await this.clearReactionBestEffort(active);
    await this.pauseAgentCardForShutdownBestEffort(state, active);
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

  private async recordCodexThreadBestEffort(params: {
    conversationKey: string;
    codexThreadId: string;
    role: RoleName;
    larkThreadId?: string;
    codexThreadHasRollout?: boolean;
  }): Promise<void> {
    try {
      await this.options.repository.upsertCodexThread(params);
    } catch (error) {
      this.log.warn({ error, codexThreadId: params.codexThreadId }, "failed to record codex thread");
    }
  }

  private async recordOrReplaceCodexThreadBestEffort(params: {
    conversationKey: string;
    codexThreadId: string;
    role: RoleName;
    larkThreadId: string;
    codexThreadHasRollout?: boolean;
    replaceExistingLarkThread?: boolean;
  }): Promise<void> {
    try {
      if (params.replaceExistingLarkThread && this.options.repository.replaceCodexThreadForLarkThread) {
        await this.options.repository.replaceCodexThreadForLarkThread(params.conversationKey, params.larkThreadId, {
          codexThreadId: params.codexThreadId,
          role: params.role,
          codexThreadHasRollout: params.codexThreadHasRollout
        });
        return;
      }
      await this.options.repository.upsertCodexThread(params);
    } catch (error) {
      this.log.warn(
        { error, codexThreadId: params.codexThreadId, larkThreadId: params.larkThreadId },
        "failed to record lark thread codex thread"
      );
    }
  }

  private async renderThreadSummaryCard(
    thread: CodexThreadRecord,
    options: { additionalWorkDurationMs?: number } = {}
  ): Promise<LarkCardJson> {
    const stats = await this.options.repository.getCodexThreadWorkStats(thread.codexThreadId);
    return renderTwinnyThreadSummaryCard({
      creatorOpenId: thread.creatorOpenId,
      createdAt: thread.createdAt,
      codexThreadId: thread.codexThreadId,
      turnCount: stats.turnCount,
      inputTokens: thread.inputTokens,
      outputTokens: thread.outputTokens,
      cachedInputTokens: thread.cachedInputTokens,
      reasoningOutputTokens: thread.reasoningOutputTokens,
      totalTokens: thread.totalTokens,
      totalWorkDurationMs: stats.totalWorkDurationMs + (options.additionalWorkDurationMs ?? 0),
      contextTokens: thread.contextTokens,
      contextWindow: thread.contextWindow,
      iconImageKey: this.options.config.lark.iconImageKey
    });
  }

  private async updateThreadSummaryCardBestEffort(
    codexThreadId: string,
    options: { active?: ActiveTurn } = {}
  ): Promise<void> {
    try {
      const thread = await this.options.repository.getCodexThreadById(codexThreadId);
      if (!thread?.cardMessageId) {
        return;
      }
      await this.options.lark.patchCard(
        thread.cardMessageId,
        await this.renderThreadSummaryCard(thread, {
          additionalWorkDurationMs: activeTurnWorkDurationMs(codexThreadId, options.active)
        })
      );
    } catch (error) {
      this.log.warn({ error, codexThreadId }, "failed to update thread summary card");
    }
  }

  private async recordThreadTokenUsageBestEffort(
    active: ActiveTurn,
    usage: CodexThreadTokenUsageUpdate
  ): Promise<void> {
    try {
      const tokenUsage = extractThreadTokenUsage(usage);
      await this.options.repository.updateCodexThreadTokenUsage({
        codexThreadId: usage.threadId,
        conversationKey: active.conversationKey,
        role: active.role,
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        cachedInputTokens: tokenUsage.cachedInputTokens,
        reasoningOutputTokens: tokenUsage.reasoningOutputTokens,
        totalTokens: tokenUsage.totalTokens,
        contextTokens: tokenUsage.contextTokens,
        contextWindow: tokenUsage.contextWindow,
        tokenUsageJson: safeJsonStringify(usage.raw) ?? "{}"
      });
      await this.updateThreadSummaryCardBestEffort(usage.threadId, { active });
    } catch (error) {
      this.log.warn({ error, threadId: usage.threadId, totalTokens: usage.totalTokens }, "failed to record token usage");
    }
  }

  private async markPendingMessagesProcessingBestEffort(
    messages: PendingMessage[],
    update: { conversationKey?: string; codexThreadId?: string; codexTurnId?: string }
  ): Promise<void> {
    await this.markMessagesProcessingBestEffort(messages.map((message) => message.messageId), update);
  }

  private async markMessagesProcessingBestEffort(
    messageIds: string[],
    update: { conversationKey?: string; codexThreadId?: string; codexTurnId?: string } = {}
  ): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }
    try {
      await this.options.repository.markLarkMessagesProcessing(messageIds, update);
    } catch (error) {
      this.log.warn({ error, messageIds }, "failed to mark lark messages processing");
    }
  }

  private async markActiveProcessingMessagesSteered(active: ActiveTurn): Promise<void> {
    const messageIds = [...active.processingMessageIds];
    if (messageIds.length === 0) {
      return;
    }
    await this.markMessagesSteeredBestEffort(messageIds, {
      conversationKey: active.conversationKey,
      codexThreadId: active.threadId,
      codexTurnId: active.turnId
    });
    for (const messageId of messageIds) {
      active.steeredMessageIds.add(messageId);
    }
    active.processingMessageIds.clear();
  }

  private async markMessagesSteeredBestEffort(
    messageIds: string[],
    update: { conversationKey?: string; codexThreadId?: string; codexTurnId?: string } = {}
  ): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }
    try {
      await this.options.repository.markLarkMessagesSteered(messageIds, update);
    } catch (error) {
      this.log.warn({ error, messageIds }, "failed to mark lark messages steered");
    }
  }

  private async markPendingMessagesQueuedBestEffort(messages: PendingMessage[]): Promise<void> {
    for (const message of messages) {
      try {
        await this.options.repository.markLarkMessageQueued(message.messageId);
      } catch (error) {
        this.log.warn({ error, messageId: message.messageId }, "failed to mark lark message queued");
      }
    }
  }

  private async markMessageRecalledBestEffort(messageId: string): Promise<void> {
    try {
      await this.options.repository.markLarkMessageRecalled(messageId);
    } catch (error) {
      this.log.warn({ error, messageId }, "failed to mark lark message recalled");
    }
  }

  private async updateQueuedMessageBestEffort(
    messageId: string,
    update: { text: string; rawEventJson?: string }
  ): Promise<void> {
    try {
      await this.options.repository.updateQueuedLarkMessage(messageId, update);
    } catch (error) {
      this.log.warn({ error, messageId }, "failed to update queued lark message");
    }
  }

  private async markMessagesCompletedBestEffort(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }
    try {
      await this.options.repository.markLarkMessagesCompleted(messageIds);
    } catch (error) {
      this.log.warn({ error, messageIds }, "failed to mark lark messages completed");
    }
  }

  private async markMessagesFailedBestEffort(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }
    try {
      await this.options.repository.markLarkMessagesFailed(messageIds);
    } catch (error) {
      this.log.warn({ error, messageIds }, "failed to mark lark messages failed");
    }
  }

  private async markMessagesInterruptedBestEffort(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }
    try {
      await this.options.repository.markLarkMessagesInterrupted(messageIds);
    } catch (error) {
      this.log.warn({ error, messageIds }, "failed to mark lark messages interrupted");
    }
  }

  private async markPendingMessagesClearedBestEffort(messages: PendingMessage[]): Promise<void> {
    const messageIds = messages.map((message) => message.messageId);
    if (messageIds.length === 0) {
      return;
    }
    try {
      await this.options.repository.markLarkMessagesCleared(messageIds);
    } catch (error) {
      this.log.warn({ error, messageIds }, "failed to mark lark messages cleared");
    }
  }

  private async getOrCreateConversation(params: {
    conversationKey: string;
    type: ConversationType;
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
      type: params.type,
      chatId: params.type === "p2p" ? params.message.senderOpenId : params.message.chatId,
      name: conversationNameForMessage(this.options.config, params.role, params.message),
      responseMode: params.type === "p2p" ? "all" : "at",
      role: params.role,
      codexThreadId: thread.threadId,
      workspace: params.workspace,
      roleCodexHome: this.options.roles.codexHomeFor(params.role)
    });
    return { conversation, created: true };
  }

  private async resolveActiveThread(
    binding: { conversation: ConversationRecord; created: boolean },
    params: { role: RoleName; workspace: string; context: MessageContext }
  ): Promise<ActiveThreadResolution> {
    const larkThreadId = params.context.larkThreadId;
    if (!larkThreadId && binding.created) {
      return { threadId: binding.conversation.codexThreadId, replacedMissingThread: false, created: true };
    }

    const existing = larkThreadId
      ? await this.options.repository.getCodexThreadByConversationAndLarkThread(
          params.context.conversationKey,
          larkThreadId
        )
      : await this.options.repository.getCodexThreadById(binding.conversation.codexThreadId);

    if (!existing) {
      if (!larkThreadId) {
        await this.recordCodexThreadBestEffort({
          conversationKey: params.context.conversationKey,
          codexThreadId: binding.conversation.codexThreadId,
          role: params.role,
          codexThreadHasRollout: false
        });
        return { threadId: binding.conversation.codexThreadId, replacedMissingThread: false };
      }
      const thread = await this.options.codex.startThread({
        role: params.role,
        cwd: params.workspace,
        approvalPolicy: "never"
      });
      await this.recordOrReplaceCodexThreadBestEffort({
        conversationKey: params.context.conversationKey,
        codexThreadId: thread.threadId,
        role: params.role,
        larkThreadId,
        codexThreadHasRollout: false
      });
      return { threadId: thread.threadId, replacedMissingThread: false, created: true };
    }

    return await this.resumeThreadRecord(existing, {
      role: params.role,
      workspace: params.workspace,
      conversationKey: params.context.conversationKey,
      larkThreadId
    });
  }

  private async resumeThreadRecord(
    thread: CodexThreadRecord,
    params: { role: RoleName; workspace: string; conversationKey: string; larkThreadId?: string }
  ): Promise<ActiveThreadResolution> {
    if (!thread.codexThreadHasRollout) {
      return { threadId: thread.codexThreadId, replacedMissingThread: false };
    }

    try {
      const resumed = await this.options.codex.resumeThread({
        role: params.role,
        threadId: thread.codexThreadId,
        cwd: params.workspace,
        approvalPolicy: "never"
      });
      if (resumed.threadId !== thread.codexThreadId) {
        await this.replaceThreadBindingBestEffort({
          conversationKey: params.conversationKey,
          codexThreadId: resumed.threadId,
          role: params.role,
          workspace: params.workspace,
          larkThreadId: params.larkThreadId,
          codexThreadHasRollout: true
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
          codexThreadId: thread.codexThreadId
        },
        "codex thread rollout missing; starting replacement thread"
      );
      const replacement = await this.options.codex.startThread({
        role: params.role,
        cwd: params.workspace,
        approvalPolicy: "never"
      });
      await this.replaceThreadBindingBestEffort({
        conversationKey: params.conversationKey,
        codexThreadId: replacement.threadId,
        role: params.role,
        workspace: params.workspace,
        larkThreadId: params.larkThreadId,
        codexThreadHasRollout: false
      });
      return {
        threadId: replacement.threadId,
        replacedMissingThread: true,
        previousThreadId: thread.codexThreadId
      };
    }
  }

  private async replaceThreadBindingBestEffort(params: {
    conversationKey: string;
    codexThreadId: string;
    role: RoleName;
    workspace: string;
    larkThreadId?: string;
    codexThreadHasRollout: boolean;
  }): Promise<void> {
    if (params.larkThreadId) {
      await this.recordOrReplaceCodexThreadBestEffort({
        conversationKey: params.conversationKey,
        codexThreadId: params.codexThreadId,
        role: params.role,
        larkThreadId: params.larkThreadId,
        codexThreadHasRollout: params.codexThreadHasRollout,
        replaceExistingLarkThread: true
      });
      return;
    }
    await this.options.repository.updateThreadBinding(params.conversationKey, {
      codexThreadId: params.codexThreadId,
      role: params.role,
      roleCodexHome: this.options.roles.codexHomeFor(params.role),
      workspace: params.workspace
    });
    await this.recordCodexThreadBestEffort({
      conversationKey: params.conversationKey,
      codexThreadId: params.codexThreadId,
      role: params.role,
      codexThreadHasRollout: params.codexThreadHasRollout
    });
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
      queueNextMessage: false,
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

  private async addQueuedReactionBestEffort(message: PendingMessage): Promise<void> {
    if (message.queuedReaction) {
      return;
    }
    try {
      message.queuedReaction = await this.options.lark.addQueuedReaction(message.messageId);
    } catch (error) {
      this.log.warn({ error, messageId: message.messageId }, "failed to add queued reaction");
      message.queuedReaction = null;
    }
  }

  private async addQueuedReactionsBestEffort(messages: PendingMessage[]): Promise<void> {
    for (const message of messages) {
      await this.addQueuedReactionBestEffort(message);
    }
  }

  private async clearQueuedReactionBestEffort(message: PendingMessage): Promise<void> {
    const reaction = message.queuedReaction;
    delete message.queuedReaction;
    if (reaction) {
      await this.removeReactionBestEffort(reaction);
    }
  }

  private async clearQueuedReactionsBestEffort(messages: PendingMessage[]): Promise<void> {
    for (const message of messages) {
      await this.clearQueuedReactionBestEffort(message);
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
      this.log.warn({ error, messageId: handle.messageId, reactionId: handle.reactionId }, "failed to remove lark reaction");
    }
  }

  private async addCompletedReactionBestEffort(active: ActiveTurn): Promise<void> {
    if (active.agentMessageMode === "card") {
      return;
    }
    if (active.completedStatus !== "completed" || active.cancelRequested || !active.lastAgentReplyMessageId) {
      return;
    }
    try {
      await this.options.lark.addCompletedReaction(active.lastAgentReplyMessageId);
    } catch (error) {
      this.log.warn(
        { error, messageId: active.lastAgentReplyMessageId },
        "failed to add completed reaction to final lark reply"
      );
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

  private async sendDirectControlBestEffort(openId: string, text: string): Promise<void> {
    try {
      await this.options.lark.sendTextToOpenId(openId, text);
    } catch (error) {
      this.log.warn({ error, openId }, "failed to send direct lark control message");
    }
  }

  private async replyGroupUnauthorizedBestEffort(messageId: string): Promise<void> {
    await this.replyControlBestEffort(messageId, "群聊未授权，需要 owner 发送 /activate 激活。");
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
    agentMessage: CodexAgentMessage
  ): Promise<void> {
    if (state.active !== active || active.cancelRequested) {
      return;
    }
    if (active.agentMessageMode === "card") {
      await state.controlQueue.enqueue(async () => {
        if (state.active !== active || active.cancelRequested) {
          return;
        }
        await this.updateAgentCardWithMessageBestEffort(state, active, agentMessage);
      });
      return;
    }
    await this.replyAgentMessageBestEffort(active, active.replyMessageId, agentMessage);
  }

  private async updateAgentCardWithMessageBestEffort(
    state: ConversationState,
    active: ActiveTurn,
    agentMessage: CodexAgentMessage
  ): Promise<void> {
    const text = agentMessage.text.trim();
    if (text.length === 0) {
      return;
    }
    if (agentMessage.phase === "commentary" || agentMessage.phase === "final_answer") {
      active.sawAgentMessagePhase = true;
    }
    const card = active.card;
    if (!card || card.fallbackPlain) {
      await this.replyAgentMessageBestEffort(active, active.replyMessageId, agentMessage);
      return;
    }
    if (agentMessage.phase === "final_answer") {
      active.finalAgentMessageText = text;
      return;
    }
    card.messages.push({ id: agentMessage.id, text });

    try {
      if (!card.messageId) {
        if (!(await this.createAgentCardBestEffort(state, active))) {
          await this.replyAgentMessageBestEffort(active, active.replyMessageId, agentMessage);
        }
        return;
      }
      await this.patchAgentCardBestEffort(state, active, "working");
    } catch (error) {
      this.log.warn({ error, messageId: active.replyMessageId }, "failed to send or update agent card; falling back to plain");
      card.fallbackPlain = true;
      this.stopAgentCardTimer(active);
      await this.replyAgentMessageBestEffort(active, active.replyMessageId, agentMessage);
    }
  }

  private async createAgentCardBestEffort(state: ConversationState, active: ActiveTurn): Promise<boolean> {
    const card = active.card;
    if (!card || card.fallbackPlain) {
      return false;
    }
    if (card.messageId) {
      return true;
    }
    try {
      const rendered = this.renderAgentCard(state, active, "working");
      const result = await this.options.lark.replyCard(card.anchorMessageId, rendered);
      if (!result?.messageId) {
        throw new Error("Lark card reply did not return message_id");
      }
      card.messageId = result.messageId;
      active.lastAgentReplyMessageId = result.messageId;
      card.lastRenderedJson = JSON.stringify(rendered);
      this.startAgentCardTimer(state, active);
      return true;
    } catch (error) {
      this.log.warn({ error, messageId: active.replyMessageId }, "failed to create agent card; falling back to plain");
      card.fallbackPlain = true;
      this.stopAgentCardTimer(active);
      return false;
    }
  }

  private async patchAgentCardBestEffort(
    state: ConversationState,
    active: ActiveTurn,
    status: "working" | "interrupted" | "paused" | "failed",
    error?: string
  ): Promise<boolean> {
    const card = active.card;
    if (!card?.messageId || card.fallbackPlain) {
      return false;
    }
    const rendered = this.renderAgentCard(state, active, status, undefined, error);
    const serialized = JSON.stringify(rendered);
    if (serialized === card.lastRenderedJson) {
      return true;
    }
    await this.options.lark.patchCard(card.messageId, rendered);
    card.lastRenderedJson = serialized;
    return true;
  }

  private async completeAgentCardBestEffort(state: ConversationState, active: ActiveTurn): Promise<void> {
    const card = active.card;
    this.stopAgentCardTimer(active);
    if (!card?.messageId || card.fallbackPlain) {
      return;
    }
    try {
      const final = splitFinalAgentCardMessages(
        card.messages,
        active.resultText ?? "",
        active.finalAgentMessageText,
        active.sawAgentMessagePhase === true
      );
      const output = await this.prepareAgentFinalCardOutputForLark(final.text, active.workspace);
      const rendered = this.renderAgentCard(state, active, "finished", output.elements, undefined, final.processMessages, final.text);
      const previousMessageId = card.messageId;
      if (state.pendingBatch.length > 0) {
        await this.options.lark.patchCard(previousMessageId, rendered);
        active.lastAgentReplyMessageId = previousMessageId;
        card.lastRenderedJson = JSON.stringify(rendered);
        await this.replyAgentCardFilesBestEffort(active.replyMessageId, output.files);
        return;
      }
      const result = await this.options.lark.replyCard(active.replyMessageId, rendered);
      const completedCardMessageId = nonEmptyString(result?.messageId);
      if (!completedCardMessageId) {
        throw new Error("Lark completed card reply did not return message_id");
      }
      card.anchorMessageId = active.replyMessageId;
      card.messageId = completedCardMessageId;
      active.lastAgentReplyMessageId = completedCardMessageId;
      card.lastRenderedJson = JSON.stringify(rendered);
      try {
        await this.options.lark.recallMessage(previousMessageId);
      } catch (error) {
        this.log.warn({ error, messageId: previousMessageId }, "failed to recall previous agent card after completion");
      }
      await this.replyAgentCardFilesBestEffort(active.replyMessageId, output.files);
    } catch (error) {
      this.log.warn({ error, messageId: active.replyMessageId }, "failed to finalize agent card; falling back to plain");
      card.fallbackPlain = true;
      await this.replyAgentMessageBestEffort(active, active.replyMessageId, {
        id: "final",
        text: active.resultText ?? ""
      });
    }
  }

  private async replyAgentCardFilesBestEffort(
    messageId: string,
    files: Array<{ fileKey: string; fileName?: string }>
  ): Promise<void> {
    for (const file of files) {
      try {
        await this.options.lark.replyFile(messageId, file.fileKey);
      } catch (error) {
        this.log.warn({ error, messageId, fileName: file.fileName }, "failed to send lark file attachment reply");
      }
    }
  }

  private async failAgentCardBestEffort(state: ConversationState, active: ActiveTurn, error: string): Promise<void> {
    this.stopAgentCardTimer(active);
    try {
      await this.patchAgentCardBestEffort(state, active, "failed", error);
    } catch (patchError) {
      this.log.warn({ error: patchError, messageId: active.replyMessageId }, "failed to update failed agent card");
      if (active.card) {
        active.card.fallbackPlain = true;
      }
    }
  }

  private async interruptAgentCardBestEffort(state: ConversationState, active: ActiveTurn): Promise<void> {
    this.stopAgentCardTimer(active);
    try {
      await this.patchAgentCardBestEffort(state, active, "interrupted");
    } catch (error) {
      this.log.warn({ error, messageId: active.replyMessageId }, "failed to update interrupted agent card");
    }
  }

  private async pauseAgentCardForShutdownBestEffort(state: ConversationState, active: ActiveTurn): Promise<void> {
    this.stopAgentCardTimer(active);
    try {
      await this.patchAgentCardBestEffort(state, active, "paused");
    } catch (error) {
      this.log.warn({ error, messageId: active.replyMessageId }, "failed to update paused agent card on shutdown");
    }
  }

  private startAgentCardTimer(state: ConversationState, active: ActiveTurn): void {
    const card = active.card;
    if (!card || card.timer || card.fallbackPlain || !card.messageId) {
      return;
    }
    card.timer = setInterval(() => {
      void state.controlQueue
        .enqueue(async () => {
          if (state.active !== active || active.cancelRequested) {
            return;
          }
          await this.patchAgentCardBestEffort(state, active, "working");
        })
        .catch((error) => {
          this.log.warn({ error, messageId: card.messageId }, "failed to update agent card elapsed time");
        });
    }, 5_000);
    card.timer.unref?.();
  }

  private stopAgentCardTimer(active: ActiveTurn): void {
    const timer = active.card?.timer;
    if (timer) {
      clearInterval(timer);
      active.card!.timer = undefined;
    }
  }

  private async moveAgentCardBestEffort(state: ConversationState, active: ActiveTurn, anchorMessageId: string): Promise<void> {
    const card = active.card;
    if (!card || card.anchorMessageId === anchorMessageId) {
      return;
    }
    const previousAnchorMessageId = card.anchorMessageId;
    card.anchorMessageId = anchorMessageId;
    if (!card.messageId || card.fallbackPlain) {
      return;
    }

    const previousMessageId = card.messageId;
    try {
      const rendered = this.renderAgentCard(state, active, "working");
      const result = await this.options.lark.replyCard(anchorMessageId, rendered);
      if (!result?.messageId) {
        throw new Error("Lark card reply did not return message_id");
      }
      card.messageId = result.messageId;
      active.lastAgentReplyMessageId = result.messageId;
      card.lastRenderedJson = JSON.stringify(rendered);
      try {
        await this.options.lark.recallMessage(previousMessageId);
      } catch (error) {
        this.log.warn({ error, messageId: previousMessageId }, "failed to recall previous agent card after steer");
      }
    } catch (error) {
      card.messageId = previousMessageId;
      card.anchorMessageId = previousAnchorMessageId;
      this.log.warn({ error, anchorMessageId }, "failed to move agent card after steer; keeping previous card");
    }
  }

  private renderAgentCard(
    state: ConversationState,
    active: ActiveTurn,
    status: "working" | "finished" | "interrupted" | "paused" | "failed",
    finalElements?: LarkCardElement[],
    error?: string,
    messages?: TwinnyAgentCardMessage[],
    summaryText?: string
  ): LarkCardJson {
    return renderTwinnyAgentCard({
      status,
      messages: messages ?? active.card?.messages ?? [],
      elapsedMs: Date.now() - active.startedAt,
      queueDepth: state.pendingBatch.length,
      queueNextMessage: state.queueNextMessage,
      stateKey: active.context.stateKey,
      runId: active.runId,
      iconImageKey: this.options.config.lark.iconImageKey,
      finalElements,
      mentionOpenIds: status === "finished" ? activeTurnMentionOpenIds(active) : undefined,
      summaryText,
      error
    });
  }

  private async replyAgentMessageBestEffort(
    active: ActiveTurn,
    messageId: string,
    agentMessage: CodexAgentMessage
  ): Promise<void> {
    const text = agentMessage.text.trim();
    if (text.length === 0) {
      return;
    }
    try {
      const outbound = await this.prepareAgentReplyForLark(text, active.workspace);
      if (outbound === undefined) {
        const result = await this.options.lark.replyMarkdown(messageId, text);
        if (result?.messageId) {
          active.lastAgentReplyMessageId = result.messageId;
        }
        return;
      }

      const result = await this.options.lark.replyPost(messageId, outbound.postContent);
      if (result?.messageId) {
        active.lastAgentReplyMessageId = result.messageId;
      }
      for (const file of outbound.files) {
        try {
          const fileResult = await this.options.lark.replyFile(messageId, file.fileKey);
          if (fileResult?.messageId) {
            active.lastAgentReplyMessageId = fileResult.messageId;
          }
        } catch (error) {
          this.log.warn({ error, messageId, fileName: file.fileName }, "failed to send lark file attachment reply");
          const errorResult = await this.options.lark.replyMarkdown(
            messageId,
            `❌ 发送图片/视频/附件失败：${toErrorMessage(error)}`
          );
          if (errorResult?.messageId) {
            active.lastAgentReplyMessageId = errorResult.messageId;
          }
        }
      }
    } catch (error) {
      this.log.warn({ error, messageId, agentMessageId: agentMessage.id }, "failed to send agent message item to lark");
    }
  }

  private async prepareAgentReplyForLark(text: string, workspace: string): Promise<PreparedAgentLarkReply | undefined> {
    if (!text.split(/\r?\n/).some((line) => line.trimStart().startsWith("SEND_TO_LARK:"))) {
      return undefined;
    }

    const builder = new LarkPostContentBuilder();
    const files: PreparedLarkFileReply[] = [];
    for (const line of text.split(/\r?\n/)) {
      const directive = parseSendToLarkDirective(line);
      if (directive.kind === "none") {
        builder.addTextLine(line);
        continue;
      }
      if (directive.kind === "invalid") {
        builder.addTextLine(formatSendToLarkError(directive.reason));
        continue;
      }

      try {
        const file = await resolveWorkspaceFileForLark(directive.path, workspace);
        if (directive.tag === "img") {
          if (!this.options.larkFiles?.uploadImage) {
            throw new Error("Lark image uploader is not configured");
          }
          const uploaded = await this.options.larkFiles.uploadImage({
            filePath: file.filePath,
            fileName: file.fileName,
            contentType: contentTypeForFileName(file.fileName)
          });
          builder.addImage(uploaded.imageKey);
          continue;
        }

        if (!this.options.larkFiles?.uploadFile) {
          throw new Error("Lark file uploader is not configured");
        }
        const uploaded = await this.options.larkFiles.uploadFile({
          filePath: file.filePath,
          fileName: file.fileName,
          fileType: directive.tag === "video" ? "mp4" : larkFileTypeForFileName(file.fileName),
          contentType: contentTypeForFileName(file.fileName)
        });
        if (directive.tag === "video") {
          builder.addVideo(uploaded.fileKey);
        } else {
          builder.addTextLine(`📎 ${file.fileName}`);
          files.push({ fileName: file.fileName, fileKey: uploaded.fileKey });
        }
      } catch (error) {
        builder.addTextLine(formatSendToLarkError(toErrorMessage(error)));
      }
    }

    return {
      postContent: builder.build(),
      files
    };
  }

  private async prepareAgentFinalCardOutputForLark(text: string, workspace: string): Promise<PreparedAgentCardReply> {
    const elements: LarkCardElement[] = [];
    const files: PreparedLarkFileReply[] = [];
    const pendingText: string[] = [];
    const flushText = (): void => {
      const markdown = pendingText.join("\n").trim();
      pendingText.splice(0);
      if (markdown.length > 0) {
        elements.push(markdownElement(markdown));
      }
    };

    for (const line of text.split(/\r?\n/)) {
      const directive = parseSendToLarkDirective(line);
      if (directive.kind === "none") {
        pendingText.push(line);
        continue;
      }
      flushText();
      if (directive.kind === "invalid") {
        elements.push(markdownElement(formatSendToLarkError(directive.reason)));
        continue;
      }

      try {
        const file = await resolveWorkspaceFileForLark(directive.path, workspace);
        if (directive.tag === "img") {
          if (!this.options.larkFiles?.uploadImage) {
            throw new Error("Lark image uploader is not configured");
          }
          const uploaded = await this.options.larkFiles.uploadImage({
            filePath: file.filePath,
            fileName: file.fileName,
            contentType: contentTypeForFileName(file.fileName)
          });
          elements.push(imageElement(uploaded.imageKey));
          continue;
        }

        if (!this.options.larkFiles?.uploadFile) {
          throw new Error("Lark file uploader is not configured");
        }
        const uploaded = await this.options.larkFiles.uploadFile({
          filePath: file.filePath,
          fileName: file.fileName,
          fileType: directive.tag === "video" ? "mp4" : larkFileTypeForFileName(file.fileName),
          contentType: contentTypeForFileName(file.fileName)
        });
        if (directive.tag === "video") {
          elements.push(mediaElement(uploaded.fileKey));
        } else {
          elements.push(markdownElement(`📎 ${file.fileName}`));
          files.push({ fileName: file.fileName, fileKey: uploaded.fileKey });
        }
      } catch (error) {
        elements.push(markdownElement(formatSendToLarkError(toErrorMessage(error))));
      }
    }
    flushText();

    return {
      elements: elements.length > 0 ? elements : [markdownElement("")],
      files
    };
  }
}

type LarkPostNode = { tag: "md"; text: string } | { tag: "img"; image_key: string } | { tag: "media"; file_key: string };
type LarkPostContent = LarkPostNode[][];

interface PreparedLarkFileReply {
  fileName: string;
  fileKey: string;
}

interface PreparedAgentLarkReply {
  postContent: LarkPostContent;
  files: PreparedLarkFileReply[];
}

interface PreparedAgentCardReply {
  elements: LarkCardElement[];
  files: PreparedLarkFileReply[];
}

type SendToLarkDirective =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "send"; tag: "img" | "video" | "file"; path: string };

class LarkPostContentBuilder {
  private readonly content: LarkPostContent = [];
  private pendingText: string[] = [];

  addTextLine(line: string): void {
    this.pendingText.push(line);
  }

  addImage(imageKey: string): void {
    this.flushText();
    this.content.push([{ tag: "img", image_key: imageKey }]);
  }

  addVideo(fileKey: string): void {
    this.flushText();
    this.content.push([{ tag: "media", file_key: fileKey }]);
  }

  build(): LarkPostContent {
    this.flushText();
    return this.content.length > 0 ? this.content : [[{ tag: "md", text: "" }]];
  }

  private flushText(): void {
    if (this.pendingText.length === 0) {
      return;
    }
    const text = this.pendingText.join("\n").trim();
    this.pendingText = [];
    if (text.length > 0) {
      this.content.push([{ tag: "md", text }]);
    }
  }
}

function parseSendToLarkDirective(line: string): SendToLarkDirective {
  const trimmed = line.trim();
  if (!trimmed.startsWith("SEND_TO_LARK:")) {
    return { kind: "none" };
  }
  const body = trimmed.slice("SEND_TO_LARK:".length).trim();
  const match = /^<(img|image|video|file)\s+([^>]*)>\s*<\/\1>$/.exec(body);
  if (!match) {
    return { kind: "invalid", reason: "SEND_TO_LARK 指令格式无效" };
  }
  const rawTag = match[1]!;
  const pathValue = parseXmlAttribute(match[2]!, "path");
  if (!pathValue) {
    return { kind: "invalid", reason: "SEND_TO_LARK 缺少 path 属性" };
  }
  return {
    kind: "send",
    tag: rawTag === "image" ? "img" : (rawTag as "img" | "video" | "file"),
    path: pathValue
  };
}

function parseXmlAttribute(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${name}="([^"]*)"`);
  const match = pattern.exec(attributes);
  return match?.[1];
}

async function resolveWorkspaceFileForLark(
  filePath: string,
  workspace: string
): Promise<{ filePath: string; realPath: string; fileName: string; size: number }> {
  if (!path.isAbsolute(filePath)) {
    throw new Error("文件路径必须是绝对路径");
  }

  const workspacePath = path.resolve(workspace);
  const requestedPath = path.resolve(filePath);
  if (!isPathInside(requestedPath, workspacePath)) {
    throw new Error("文件不在 workspace 内");
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(requestedPath);
  } catch {
    throw new Error("文件不存在");
  }

  const realWorkspace = await fs.realpath(workspacePath).catch(() => workspacePath);
  if (!isPathInside(realPath, realWorkspace)) {
    throw new Error("真实文件不在 workspace 内");
  }

  const stat = await fs.stat(realPath);
  if (!stat.isFile()) {
    throw new Error("路径不是普通文件");
  }

  return {
    filePath: requestedPath,
    realPath,
    fileName: path.basename(requestedPath),
    size: stat.size
  };
}

function isPathInside(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function formatSendToLarkError(reason: string): string {
  return `❌ 发送图片/视频/附件失败：${reason}`;
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
  if (command === "next") {
    return { kind: "next" };
  }
  if (command === "steer") {
    return { kind: "steer" };
  }
  if (command === "status") {
    return { kind: "status" };
  }
  if (command === "new") {
    return { kind: "new" };
  }
  if (command === "new_topic") {
    return { kind: "new_topic" };
  }
  if (command === "project") {
    return { kind: "project", name: rest };
  }
  if (command === "help") {
    return { kind: "help" };
  }
  if (command === "activate") {
    return { kind: "activate", text: rest };
  }
  if (command === "deactivate") {
    return { kind: "deactivate" };
  }
  if (command === "queue") {
    return { kind: "queue", text: rest };
  }
  return { kind: "message", text };
}

function parseTwinnyCardAction(value: Record<string, unknown>): ParsedCardActionCommand | undefined {
  if (value.twinny !== true) {
    return undefined;
  }
  const action = value.action;
  const stateKey = typeof value.stateKey === "string" ? value.stateKey : undefined;
  const runId = typeof value.runId === "number" && Number.isInteger(value.runId) ? value.runId : undefined;
  if ((action !== "stop" && action !== "next" && action !== "queue") || !stateKey || runId === undefined) {
    return undefined;
  }
  return {
    action,
    stateKey,
    runId,
    text: action === "stop" ? "/stop" : action === "next" ? "/next" : "/queue"
  };
}

function activeTurnWorkDurationMs(codexThreadId: string, active: ActiveTurn | undefined, now = Date.now()): number {
  if (!active || active.threadId !== codexThreadId || active.cancelRequested || active.completedStatus !== undefined) {
    return 0;
  }
  const durationMs = now - active.startedAt;
  return Number.isFinite(durationMs) && durationMs > 0 ? Math.trunc(durationMs) : 0;
}

function parseActivateCommand(
  text: string
): { kind: "valid"; responseMode: Exclude<ConversationResponseMode, "none">; role?: RoleName } | { kind: "invalid"; message: string } {
  let responseMode: Exclude<ConversationResponseMode, "none"> = "at";
  let role: RoleName | undefined;
  const tokens = text.split(/\s+/).map((token) => token.trim().toLowerCase()).filter(Boolean);
  for (const token of tokens) {
    if (token === "all" || token === "at") {
      responseMode = token;
      continue;
    }
    if (token === "guest" || token === "owner") {
      role = token;
      continue;
    }
    return { kind: "invalid", message: "用法：/activate [all|at] [guest|owner]" };
  }
  return { kind: "valid", responseMode, role };
}

function createMessageContext(type: ConversationType, message: IncomingLarkMessage): MessageContext {
  const conversationKey = conversationKeyForChat(type, message);
  const larkThreadId = message.larkThreadId;
  return {
    type,
    conversationKey,
    stateKey: larkThreadId ? `${conversationKey}_thread_${safePathSegment(larkThreadId)}` : conversationKey,
    larkThreadId
  };
}

function createProjectTopicProxyContext(context: MessageContext, larkThreadId: string): MessageContext {
  return {
    type: "topic_group",
    conversationKey: context.conversationKey,
    stateKey: `${context.conversationKey}_thread_${safePathSegment(larkThreadId)}`,
    larkThreadId
  };
}

function createProjectTopicProxyMessage(
  message: IncomingLarkMessage,
  proxyMessageId: string,
  larkThreadId: string
): IncomingLarkMessage {
  return {
    ...message,
    messageId: proxyMessageId,
    chatType: "topic_group",
    larkGroupId: message.larkGroupId ?? message.chatId,
    larkThreadId
  };
}

function isTextOrPostMessage(message: IncomingLarkMessage): boolean {
  const messageType = message.messageType.toLowerCase();
  return messageType === "text" || messageType === "post";
}

function rawMessageForLarkReply(message: IncomingLarkMessage): { messageType: string; content: unknown } {
  const rawMessage = rawLarkMessageRecord(message.raw);
  const messageType = nonEmptyString(
    rawStringField(rawMessage, "message_type") ?? rawStringField(rawMessage, "msg_type") ?? message.messageType
  );
  const body = isRecord(rawMessage?.body) ? rawMessage.body : undefined;
  const content = rawMessage?.content ?? body?.content;
  if (!messageType || content === undefined) {
    throw new TwinnyError("Project topic proxy message raw content is missing", "LARK_MESSAGE_MALFORMED");
  }
  return { messageType, content };
}

function rawLarkMessageRecord(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const event = isRecord(raw.event) ? raw.event : raw;
  return isRecord(event.message) ? event.message : event;
}

function rawStringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === "string" ? value : undefined;
}

function createBotMenuContext(operatorOpenId: string): MessageContext {
  const conversationKey = conversationKeyForP2p(operatorOpenId);
  return {
    type: "p2p",
    conversationKey,
    stateKey: conversationKey
  };
}

function createBotMenuGroupContext(chatId: string): MessageContext {
  const conversationKey = conversationKeyForGroup(chatId);
  return {
    type: "group",
    conversationKey,
    stateKey: conversationKey
  };
}

function messageForBotMenuAction(action: IncomingLarkBotMenuAction): IncomingLarkMessage {
  const chatId = action.chatId ?? action.operatorOpenId;
  const chatType = action.chatId ? "group" : "p2p";
  return {
    eventId: action.eventId,
    messageId: `bot_menu:${action.eventId}`,
    chatId,
    chatType,
    messageType: "bot_menu",
    senderOpenId: action.operatorOpenId,
    senderName: action.operatorName,
    larkGroupId: action.chatId,
    text: "",
    createTime: action.timestamp,
    raw: action.raw
  };
}

function contextForRecoveredRecord(record: LarkMessageRecord): MessageContext {
  const conversationKey = record.conversationKey ?? conversationKeyForP2p(record.larkUserId);
  const type: ConversationType = conversationKey.startsWith("group_") ? "group" : "p2p";
  return {
    type,
    conversationKey,
    stateKey: record.larkThreadId ? `${conversationKey}_thread_${safePathSegment(record.larkThreadId)}` : conversationKey,
    larkThreadId: record.larkThreadId
  };
}

function conversationKeyFromStateKey(stateKey: string): string {
  const threadMarker = "_thread_";
  const threadIndex = stateKey.indexOf(threadMarker);
  return threadIndex >= 0 ? stateKey.slice(0, threadIndex) : stateKey;
}

function messageMentionsBot(message: IncomingLarkMessage, botOpenId: string | undefined): boolean {
  if (!botOpenId) {
    return false;
  }
  return (message.mentions ?? []).some((mention) => mention.openId === botOpenId);
}

function stripBotMention(text: string, message: IncomingLarkMessage, botOpenId: string | undefined): string {
  if (!botOpenId) {
    return text;
  }
  let stripped = text;
  for (const mention of message.mentions ?? []) {
    if (mention.openId !== botOpenId) {
      continue;
    }
    if (mention.key) {
      stripped = stripped.split(mention.key).join("");
    }
    if (mention.name) {
      stripped = stripped.replace(new RegExp(`^\\s*@${escapeRegExp(mention.name)}\\s*`), "");
    }
  }
  return stripped.trimStart();
}

function helpTextFor(message: IncomingLarkMessage, context: MessageContext, config: TwinnyConfig): string {
  const lines = [
    "可用指令：",
    "/help - 查看可用指令和使用说明",
    "/status - 查看当前会话、Codex thread 和 token 用量",
    "/new - 新开 Codex thread；会停止当前任务并清空待处理消息",
    "/stop - 停止当前任务并清空待处理消息",
    "/next - 打断当前任务，并执行队列中的下一条消息",
    "/steer - 将队列中的下一批消息注入当前任务",
    "/queue <message> - 将消息加入下一轮队列，不注入当前任务",
    "/project <name> - owner 创建 twinny 项目群"
  ];
  if (isGroupConversationType(context.type) && roleForSender(config, message.senderOpenId) === "owner") {
    lines.push(
      "/activate [all|at] [guest|owner] - 激活群聊、设置响应模式并刷新群名",
      "/new_topic - 在当前群内创建一个新的会话话题",
      "/deactivate - 停用当前群聊"
    );
  }
  return lines.join("\n");
}

function classifyInitialRoute(
  state: ConversationState,
  parsed: ParsedCommand,
  originalText: string
): { routeKind: LarkMessageRouteKind; status: "queued" | "processing"; text: string } {
  if (parsed.kind === "queue" && parsed.text.length > 0) {
    return { routeKind: "queued_message", status: "queued", text: parsed.text };
  }
  if (
    parsed.kind === "help" ||
    parsed.kind === "status" ||
    parsed.kind === "stop" ||
    parsed.kind === "next" ||
    parsed.kind === "steer" ||
    parsed.kind === "new" ||
    parsed.kind === "new_topic" ||
    parsed.kind === "project" ||
    parsed.kind === "activate" ||
    parsed.kind === "deactivate" ||
    parsed.kind === "queue"
  ) {
    return { routeKind: "control_message", status: "processing", text: originalText };
  }
  if (state.queueNextMessage) {
    return { routeKind: "queued_message", status: "queued", text: parsed.text };
  }
  if (state.pendingBatch.length > 0 || state.active?.cancelRequested) {
    return { routeKind: "queued_message", status: "queued", text: parsed.text };
  }
  if (state.active) {
    return { routeKind: "steered_message", status: "processing", text: parsed.text };
  }
  return { routeKind: "message", status: "processing", text: parsed.text };
}

function toPendingMessage(
  message: IncomingLarkMessage,
  text: string,
  options: { queueBoundary?: boolean } = {}
): PendingMessage {
  return {
    messageId: message.messageId,
    text,
    original: message,
    queueBoundary: options.queueBoundary ?? false
  };
}

function countNextPendingBatch(state: ConversationState): number {
  if (state.pendingBatch.length === 0) {
    return 0;
  }
  for (let index = 1; index < state.pendingBatch.length; index += 1) {
    if (state.pendingBatch[index]!.queueBoundary) {
      return index;
    }
  }
  return state.pendingBatch.length;
}

function splitFinalAgentCardMessages(
  messages: TwinnyAgentCardMessage[],
  fallbackFinalText: string,
  explicitFinalText?: string,
  keepAllProcessMessages = false
): { text: string; processMessages: TwinnyAgentCardMessage[] } {
  if (explicitFinalText !== undefined) {
    return { text: explicitFinalText, processMessages: messages };
  }
  if (keepAllProcessMessages) {
    return { text: fallbackFinalText, processMessages: messages };
  }
  if (messages.length === 0) {
    return { text: fallbackFinalText, processMessages: [] };
  }
  const finalMessage = messages[messages.length - 1]!;
  return {
    text: finalMessage.text,
    processMessages: messages.slice(0, -1)
  };
}

function activeTurnMentionOpenIds(active: ActiveTurn): string[] {
  const seen = new Set<string>();
  const openIds: string[] = [];
  for (const message of active.messagesById.values()) {
    const openId = nonEmptyString(message.original.senderOpenId);
    if (!openId || seen.has(openId)) {
      continue;
    }
    seen.add(openId);
    openIds.push(openId);
  }
  return openIds;
}

function formatPendingMessageForCodex(message: PendingMessage): string {
  const timestamp = message.original.createTime === undefined ? "" : String(message.original.createTime);
  const attributes: Array<[string, string]> = [
    ["lark_message_id", message.messageId],
    ["timestamp", timestamp],
    ["sender_ouid", message.original.senderOpenId]
  ];
  const senderName = nonEmptyString(message.original.senderName);
  if (senderName) {
    attributes.push(["sender_name", senderName]);
  }
  if (message.original.rawForCodex) {
    attributes.push(["raw", "true"]);
  }
  const renderedAttributes = attributes
    .map(([name, value]) => `${name}="${escapeXmlAttribute(value)}"`)
    .join(" ");
  return `<lark_message ${renderedAttributes}>\n${message.text}\n</lark_message>`;
}

interface TokenBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface ThreadTokenUsageSnapshot extends TokenBreakdown {
  contextTokens: number;
  contextWindow: number;
}

interface RateLimitWindowStatus {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

function formatThreadTokenStatus(thread: CodexThreadRecord | undefined): string[] {
  const breakdown = extractThreadTokenBreakdown(thread);
  const cacheHitRate = breakdown.inputTokens > 0 ? breakdown.cachedInputTokens / breakdown.inputTokens : 0;
  const contextUsage = breakdown.contextWindow > 0 ? breakdown.contextTokens / breakdown.contextWindow : 0;
  return [
    "Thread Token Usage:",
    `- total: ${formatInteger(breakdown.totalTokens)}`,
    `- input: ${formatInteger(breakdown.inputTokens)}`,
    `- output: ${formatInteger(breakdown.outputTokens)}`,
    `- cached input: ${formatInteger(breakdown.cachedInputTokens)}`,
    `- reasoning output: ${formatInteger(breakdown.reasoningOutputTokens)}`,
    `- cache hit rate: ${formatPercent(cacheHitRate)}`,
    `- context: ${formatInteger(breakdown.contextTokens)} / ${formatInteger(breakdown.contextWindow)} (${formatPercent(contextUsage)})`
  ];
}

function extractThreadTokenBreakdown(thread: CodexThreadRecord | undefined): ThreadTokenUsageSnapshot {
  const raw = parseStoredRawEvent(thread?.tokenUsageJson);
  const total = firstRecord(
    nestedRecord(raw, ["tokenUsage", "total"]),
    nestedRecord(raw, ["usage", "total"]),
    nestedRecord(raw, ["total"])
  );
  const last = firstRecord(
    nestedRecord(raw, ["tokenUsage", "last"]),
    nestedRecord(raw, ["usage", "last"]),
    nestedRecord(raw, ["last"])
  );
  return {
    totalTokens: finiteNumber(total?.totalTokens, total?.total_tokens, thread?.totalTokens) ?? 0,
    inputTokens: finiteNumber(total?.inputTokens, total?.input_tokens, total?.prompt_tokens, thread?.inputTokens) ?? 0,
    cachedInputTokens:
      finiteNumber(total?.cachedInputTokens, total?.cached_input_tokens, total?.cached_tokens, thread?.cachedInputTokens) ?? 0,
    outputTokens: finiteNumber(total?.outputTokens, total?.output_tokens, total?.completion_tokens, thread?.outputTokens) ?? 0,
    reasoningOutputTokens:
      finiteNumber(total?.reasoningOutputTokens, total?.reasoning_output_tokens, thread?.reasoningOutputTokens) ?? 0,
    contextTokens: finiteNumber(last?.totalTokens, last?.total_tokens, thread?.contextTokens) ?? 0,
    contextWindow:
      finiteNumber(
        nestedValue(raw, ["modelContextWindow"]),
        nestedValue(raw, ["model_context_window"]),
        nestedValue(raw, ["tokenUsage", "modelContextWindow"]),
        nestedValue(raw, ["tokenUsage", "model_context_window"]),
        thread?.contextWindow
      ) ?? 0
  };
}

function extractThreadTokenUsage(usage: CodexThreadTokenUsageUpdate): ThreadTokenUsageSnapshot {
  const raw = usage.raw;
  const total = firstRecord(
    nestedRecord(raw, ["tokenUsage", "total"]),
    nestedRecord(raw, ["usage", "total"]),
    nestedRecord(raw, ["total"])
  );
  const last = firstRecord(
    nestedRecord(raw, ["tokenUsage", "last"]),
    nestedRecord(raw, ["usage", "last"]),
    nestedRecord(raw, ["last"])
  );
  return {
    totalTokens:
      finiteNumber(
        usage.totalTokens,
        total?.totalTokens,
        total?.total_tokens,
        nestedValue(raw, ["tokenUsage", "totalTokens"]),
        nestedValue(raw, ["tokenUsage", "total_tokens"]),
        nestedValue(raw, ["usage", "totalTokens"]),
        nestedValue(raw, ["usage", "total_tokens"])
      ) ?? 0,
    inputTokens:
      finiteNumber(total?.inputTokens, total?.input_tokens, total?.promptTokens, total?.prompt_tokens) ?? 0,
    cachedInputTokens:
      finiteNumber(
        total?.cachedInputTokens,
        total?.cached_input_tokens,
        total?.cacheInputTokens,
        total?.cache_input_tokens,
        total?.cachedTokens,
        total?.cached_tokens
      ) ?? 0,
    outputTokens:
      finiteNumber(total?.outputTokens, total?.output_tokens, total?.completionTokens, total?.completion_tokens) ?? 0,
    reasoningOutputTokens:
      finiteNumber(
        total?.reasoningOutputTokens,
        total?.reasoning_output_tokens,
        total?.reasoningTokens,
        total?.reasoning_tokens
      ) ?? 0,
    contextTokens: finiteNumber(last?.totalTokens, last?.total_tokens) ?? 0,
    contextWindow:
      finiteNumber(
        nestedValue(raw, ["modelContextWindow"]),
        nestedValue(raw, ["model_context_window"]),
        nestedValue(raw, ["tokenUsage", "modelContextWindow"]),
        nestedValue(raw, ["tokenUsage", "model_context_window"]),
        nestedValue(raw, ["usage", "modelContextWindow"]),
        nestedValue(raw, ["usage", "model_context_window"])
      ) ?? 0
  };
}

function formatAccountRateLimitStatus(value: unknown): string[] {
  const windows = collectRateLimitWindows(value);
  const fiveHour = findRateLimitWindow(windows, 5 * 60);
  const sevenDay = findRateLimitWindow(windows, 7 * 24 * 60);
  return [
    "Codex Account Usage:",
    `- 5h: ${fiveHour ? formatRateLimitWindow(fiveHour) : "unavailable"}`,
    `- 7d: ${sevenDay ? formatRateLimitWindow(sevenDay) : "unavailable"}`
  ];
}

function collectRateLimitWindows(value: unknown): RateLimitWindowStatus[] {
  const snapshots = collectRateLimitSnapshots(value);
  const windows: RateLimitWindowStatus[] = [];
  for (const snapshot of snapshots) {
    for (const key of ["primary", "secondary"] as const) {
      const window = snapshot[key];
      if (!isRecord(window)) {
        continue;
      }
      const usedPercent = finiteNumber(window.usedPercent, window.used_percent);
      if (usedPercent === undefined) {
        continue;
      }
      windows.push({
        usedPercent,
        windowDurationMins: finiteNumber(window.windowDurationMins, window.window_duration_mins),
        resetsAt: finiteNumber(window.resetsAt, window.resets_at)
      });
    }
  }
  return windows;
}

function collectRateLimitSnapshots(value: unknown): Record<string, unknown>[] {
  const snapshots: Record<string, unknown>[] = [];
  const root = isRecord(value) ? value : undefined;
  const primary = root?.rateLimits ?? root?.rate_limits;
  if (isRecord(primary)) {
    snapshots.push(primary);
  }
  const byLimitId = root?.rateLimitsByLimitId ?? root?.rate_limits_by_limit_id;
  if (isRecord(byLimitId)) {
    for (const snapshot of Object.values(byLimitId)) {
      if (isRecord(snapshot)) {
        snapshots.push(snapshot);
      }
    }
  }
  return snapshots;
}

function findRateLimitWindow(
  windows: RateLimitWindowStatus[],
  durationMins: number
): RateLimitWindowStatus | undefined {
  return windows.find((window) => window.windowDurationMins === durationMins);
}

function formatRateLimitWindow(window: RateLimitWindowStatus): string {
  const parts = [`${formatPercent(window.usedPercent / 100)} used`];
  if (window.resetsAt !== undefined) {
    parts.push(`resets ${formatUnixTimestamp(window.resetsAt)}`);
  }
  return parts.join(", ");
}

function formatUnixTimestamp(value: number): string {
  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}

function formatInteger(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseStoredRawEvent(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function queuedLarkMessageRecord(value: unknown): LarkMessageRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.status !== "queued" || typeof value.larkMessageId !== "string" || typeof value.larkUserId !== "string") {
    return undefined;
  }
  return value as unknown as LarkMessageRecord;
}

function removePendingMessageById(messages: PendingMessage[], messageId: string): PendingMessage | undefined {
  const index = messages.findIndex((message) => message.messageId === messageId);
  if (index < 0) {
    return undefined;
  }
  return messages.splice(index, 1)[0];
}

function patchLarkMessageRawEvent(existingRaw: unknown, editRaw: unknown): unknown {
  const patch = extractLarkMessagePatch(editRaw);
  if (!patch || !isRecord(existingRaw)) {
    return existingRaw ?? editRaw;
  }

  const existingMessage = isRecord(existingRaw.message) ? existingRaw.message : {};
  return {
    ...existingRaw,
    message: {
      ...existingMessage,
      ...patch
    }
  };
}

function larkMessageContentChanged(previousRaw: unknown, latestRaw: unknown): boolean {
  const previous = larkMessageContentSignature(previousRaw);
  const latest = larkMessageContentSignature(latestRaw);
  if (!previous || !latest) {
    return true;
  }
  return previous !== latest;
}

function larkMessageContentSignature(raw: unknown): string | undefined {
  const patch = extractLarkMessagePatch(raw);
  if (!patch) {
    return undefined;
  }
  return JSON.stringify({
    messageType: patch.message_type,
    content: patch.content
  });
}

function extractLarkMessagePatch(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const event = isRecord(raw.event) ? raw.event : raw;
  const message = isRecord(event.message) ? event.message : event;
  const patch: Record<string, unknown> = {};
  for (const field of [
    "message_id",
    "chat_id",
    "chat_type",
    "create_time",
    "update_time",
    "updated_time",
    "thread_id",
    "parent_id"
  ]) {
    const value = message[field] ?? event[field];
    if (value !== undefined) {
      patch[field] = value;
    }
  }
  const messageType = message.message_type ?? event.message_type ?? message.msg_type ?? event.msg_type;
  if (messageType !== undefined) {
    patch.message_type = messageType;
  }
  const body = isRecord(message.body) ? message.body : isRecord(event.body) ? event.body : undefined;
  const content = message.content ?? event.content ?? body?.content;
  if (content !== undefined) {
    patch.content = content;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function extractLarkMessageThreadId(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const data = isRecord(raw.data) ? raw.data : undefined;
  const threadId = data?.thread_id;
  if (typeof threadId === "string" && threadId.trim()) {
    return threadId.trim();
  }
  return undefined;
}

function lastDefined<T>(values: Array<T | undefined>): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function firstRecord(...values: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  return values.find((value) => value !== undefined);
}

function nestedRecord(value: unknown, path: string[]): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function nestedValue(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function finiteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function formatDownloadedFileForCodex(
  file: { path: string; resourceType: "image" | "file"; fileKey: string; size: number; codexTag?: "img" | "video" | "file" },
  messageType: string
): string {
  const tag = file.codexTag ?? codexFileTagForMessage(file.resourceType, messageType);
  return (
    `<${tag} path="${escapeXmlAttribute(file.path)}" ` +
    `lark_file_key="${escapeXmlAttribute(file.fileKey)}" size="${escapeXmlAttribute(String(file.size))}">` +
    `Saved locally</${tag}>`
  );
}

function codexFileTagForMessage(resourceType: "image" | "file", messageType: string): "img" | "video" | "file" {
  if (resourceType === "image") {
    return "img";
  }
  return messageType === "video" || messageType === "media" ? "video" : "file";
}

function formatMessageTextWithDownloadedFiles(
  text: string,
  files: Array<{
    path: string;
    resourceType: "image" | "file";
    fileKey: string;
    size: number;
    codexTag?: "img" | "video" | "file";
    textPlaceholder?: string;
  }>,
  messageType: string
): string {
  if (files.length === 0) {
    return text;
  }

  if (!files.some((file) => file.textPlaceholder)) {
    return files.map((file) => formatDownloadedFileForCodex(file, messageType)).join("\n");
  }

  let rendered = text;
  const unmatched: string[] = [];
  for (const file of files) {
    const xml = formatDownloadedFileForCodex(file, messageType);
    if (file.textPlaceholder && rendered.includes(file.textPlaceholder)) {
      rendered = rendered.split(file.textPlaceholder).join(xml);
    } else {
      unmatched.push(xml);
    }
  }

  if (unmatched.length === 0) {
    return rendered;
  }
  return rendered.trim() ? `${rendered}\n${unmatched.join("\n")}` : unmatched.join("\n");
}

function contentTypeForFileName(fileName: string): string | undefined {
  switch (path.extname(fileName).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".mp4":
      return "video/mp4";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    default:
      return undefined;
  }
}

function larkFileTypeForFileName(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".opus":
      return "opus";
    case ".mp4":
      return "mp4";
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "message";
}

function createLarkUuid(prefix: string, ...parts: string[]): string {
  const key = [prefix, ...parts].map(safePathSegment).join("-");
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  if (message.chatType === "group" || message.chatType === "topic_group") {
    return message.chatName?.trim() || message.chatId;
  }
  if (role === "owner") {
    return config.owner.displayName.trim() || message.senderName?.trim() || message.senderOpenId;
  }
  return message.senderName?.trim() || message.senderOpenId;
}
