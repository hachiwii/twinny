import fs from "node:fs/promises";
import path from "node:path";
import { LRUCache } from "lru-cache";
import type { Logger } from "pino";
import { TwinnyError, toErrorMessage } from "../errors.js";
import { normalizeIncomingLarkMessage } from "../lark/filters.js";
import { logger as defaultLogger } from "../observability/logs.js";
import type {
  CodexThreadTokenUsageUpdate,
  CodexTurnResult,
  ConversationRecord,
  IncomingLarkMessage,
  LarkMessageRecord,
  LarkMessageRouteKind,
  LarkReactionHandle,
  NewConversationRecord,
  RoleName,
  CodexThreadRecord,
  UserRecord,
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
  getUserByLarkUserId(larkUserId: string): Promise<UserRecord | undefined> | UserRecord | undefined;
  getCodexThreadById(codexThreadId: string): Promise<CodexThreadRecord | undefined> | CodexThreadRecord | undefined;
  getLarkMessageById(larkMessageId: string): Promise<unknown | undefined> | unknown | undefined;
  listUnfinishedLarkMessages(): Promise<LarkMessageRecord[]> | LarkMessageRecord[];
  upsertUser(input: {
    larkUserId: string;
    name?: string;
    role?: RoleName;
    seenAt?: number;
  }): Promise<unknown> | unknown;
  upsertCodexThread(input: {
    codexThreadId: string;
    conversationKey: string;
    role: RoleName;
    larkThreadId?: string;
  }): Promise<unknown> | unknown;
  updateCodexThreadTokenUsage(input: {
    codexThreadId: string;
    conversationKey: string;
    role: RoleName;
    totalTokens: number;
    tokenUsageJson: string;
  }): Promise<unknown> | unknown;
  insertLarkMessage(input: {
    larkMessageId: string;
    eventId: string;
    larkUserId: string;
    larkGroupId?: string;
    larkThreadId?: string;
    conversationKey?: string;
    codexThreadId?: string;
    codexTurnId?: string;
    routeKind: LarkMessageRouteKind;
    status: "queued" | "processing";
    text: string;
    larkCreateTime?: number;
    rawEventJson?: string;
  }): Promise<unknown> | unknown;
  markLarkMessageQueued(larkMessageId: string): Promise<void> | void;
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
  removeReaction(handle: LarkReactionHandle): Promise<void>;
  replyText(messageId: string, text: string): Promise<void>;
  replyMarkdown(messageId: string, markdown: string): Promise<{ messageId?: string } | void>;
  replyPost(
    messageId: string,
    content: Array<Array<{ tag: "md"; text: string } | { tag: "img"; image_key: string } | { tag: "media"; file_key: string }>>
  ): Promise<{ messageId?: string } | void>;
  replyFile(messageId: string, fileKey: string): Promise<{ messageId?: string } | void>;
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
  larkFiles?: LarkFileDownloader;
  roles: RoleHomeResolver;
  logger?: Logger;
  nameLookupFailureTtlMs?: number;
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
  lastAgentReplyMessageId?: string;
  completedStatus?: CodexTurnResult["status"];
  pendingSteers: PendingMessage[];
  messageIds: Set<string>;
  processingMessageIds: Set<string>;
  steeredMessageIds: Set<string>;
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
  | { kind: "next" }
  | { kind: "status" }
  | { kind: "new" }
  | { kind: "help" };

export class ConversationManager {
  private static readonly recoveryPrompt = "Twinny daemon has beed reloaded, continue with the unfinished work.";
  private static readonly helpText = [
    "可用指令：",
    "/help - 查看可用指令和使用说明",
    "/status - 查看当前会话、Codex thread 和 token 用量",
    "/new - 新开 Codex thread；会停止当前任务并清空待处理消息",
    "/stop - 停止当前任务并清空待处理消息",
    "/next - 打断当前任务，并执行队列中的下一条消息",
    "/queue <message> - 将消息加入下一轮队列，不注入当前任务"
  ].join("\n");

  private readonly states = new Map<string, ConversationState>();
  private readonly dedupe: LRUCache<string, true>;
  private readonly nameLookupFailureCache = new Map<string, number>();
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

    if (message.messageType !== "text" && (message.resources?.length ?? 0) === 0 && !message.rawForCodex) {
      this.log.debug({ messageId: message.messageId, messageType: message.messageType }, "unsupported lark message ignored");
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

    const cancelPromises: Promise<boolean>[] = [];
    for (const state of this.states.values()) {
      state.submittedMessages.clear();
      state.processingMessage = undefined;
      this.clearPendingMessages(state);
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
      { state: ConversationState; records: LarkMessageRecord[]; messages: PendingMessage[] }
    >();
    const recoverableStates = new Map<string, ConversationState>();

    for (const record of records) {
      const conversationKey = record.conversationKey ?? conversationKeyForP2p(record.larkUserId);
      const state = this.getState(conversationKey);
      recoverableStates.set(conversationKey, state);
      this.dedupe.set(record.larkMessageId, true);
      const message = await this.toRecoveredPendingMessage(record);
      if (record.status === "processing") {
        const group = processingGroups.get(conversationKey) ?? { state, records: [], messages: [] };
        group.records.push(record);
        group.messages.push(message);
        processingGroups.set(conversationKey, group);
      } else if (record.status === "queued") {
        state.pendingBatch.push(message);
      }
    }

    for (const [conversationKey, group] of processingGroups) {
      await group.state.controlQueue.enqueue(() =>
        this.startRecoveredProcessingMessages(group.state, conversationKey, group.records, group.messages)
      );
    }
    for (const [conversationKey, state] of recoverableStates) {
      await state.controlQueue.enqueue(() => this.startPendingBatch(state, conversationKey));
    }
  }

  private async toRecoveredPendingMessage(record: LarkMessageRecord): Promise<PendingMessage> {
    const raw = parseStoredRawEvent(record.rawEventJson);
    const normalized = normalizeIncomingLarkMessage(raw);
    if (!normalized) {
      throw new TwinnyError(
        `Cannot recover Lark message ${record.larkMessageId} from raw event JSON`,
        "LARK_MESSAGE_RECOVERY_FAILED"
      );
    }
    normalized.senderName = await this.resolveSenderName(
      normalized,
      roleForSender(this.options.config, normalized.senderOpenId)
    );
    if (record.status === "queued") {
      await this.prepareMessageResources(record.conversationKey ?? conversationKeyForP2p(record.larkUserId), normalized);
    }
    const text = (record.status === "queued" && (normalized.resources?.length ?? 0) > 0) ? normalized.text : record.text;
    return toPendingMessage(normalized, text);
  }

  private async startRecoveredProcessingMessages(
    state: ConversationState,
    conversationKey: string,
    records: LarkMessageRecord[],
    messages: PendingMessage[]
  ): Promise<void> {
    if (state.active || messages.length === 0) {
      return;
    }
    const anchor = messages[messages.length - 1]!;
    const conversation = await this.getOrCreateRecoveryConversation(conversationKey, records, anchor.original);
    const role = conversation.role;
    const workspace = conversation.workspace;
    const activeThread = conversation.codexThreadHasRollout
      ? await this.resumeExistingThread(conversation, { role, workspace, conversationKey })
      : { threadId: conversation.codexThreadId, replacedMissingThread: false };
    if (activeThread.replacedMissingThread) {
      await this.notifyThreadReplacementBestEffort(anchor.messageId, activeThread.previousThreadId, activeThread.threadId);
    }
    await this.recordCodexThreadBestEffort({
      conversationKey,
      codexThreadId: activeThread.threadId,
      role,
      larkThreadId: anchor.original.larkThreadId
    });
    await this.beginActiveTurn(state, conversationKey, {
      messages,
      role,
      threadId: activeThread.threadId,
      workspace,
      input: ConversationManager.recoveryPrompt
    });
  }

  private async getOrCreateRecoveryConversation(
    conversationKey: string,
    records: LarkMessageRecord[],
    message: IncomingLarkMessage
  ): Promise<ConversationRecord> {
    const existing = await this.options.repository.findByConversationKey(conversationKey);
    if (existing) {
      return existing;
    }
    const role = roleForSender(this.options.config, message.senderOpenId);
    const workspace = await this.options.workspaces.ensureWorkspace(conversationKey);
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
    return await this.options.repository.create({
      conversationKey,
      type: "p2p",
      chatId: message.senderOpenId,
      name: conversationNameForMessage(this.options.config, role, message),
      role,
      codexThreadId: threadId,
      codexThreadHasRollout: recoveredThreadId !== undefined,
      workspace,
      roleCodexHome: this.options.roles.codexHomeFor(role)
    });
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
      return;
    }

    state.processingMessage = message;
    try {
      if (await this.isPersistedDuplicateMessage(message.messageId)) {
        return;
      }
      await this.routeMessage(state, conversationKey, message);
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

  private async isPersistedDuplicateMessage(larkMessageId: string): Promise<boolean> {
    const existing = await this.options.repository.getLarkMessageById(larkMessageId);
    if (!existing) {
      return false;
    }
    this.log.debug({ messageId: larkMessageId }, "persisted duplicate lark message ignored");
    return true;
  }

  private async routeMessage(
    state: ConversationState,
    conversationKey: string,
    message: IncomingLarkMessage
  ): Promise<void> {
    await this.prepareMessageResources(conversationKey, message);
    const parsed = parseSlashCommand(message.text);
    await this.recordIncomingMessage(state, conversationKey, message, parsed);
    if (parsed.kind === "help") {
      await this.handleHelpCommand(message);
      return;
    }
    if (parsed.kind === "status") {
      await this.handleStatusCommand(state, conversationKey, message);
      return;
    }
    if (parsed.kind === "stop") {
      await this.handleStopCommand(state, message);
      return;
    }
    if (parsed.kind === "next") {
      await this.handleNextCommand(state, conversationKey, message);
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

  private async recordIncomingMessage(
    state: ConversationState,
    conversationKey: string,
    message: IncomingLarkMessage,
    parsed: ParsedCommand
  ): Promise<void> {
    const role = roleForSender(this.options.config, message.senderOpenId);
    const route = classifyInitialRoute(state, parsed, message.text);
    const senderName = await this.resolveSenderName(message, role);
    message.senderName = senderName;
    await this.options.repository.upsertUser({
      larkUserId: message.senderOpenId,
      name: senderName,
      role,
      seenAt: message.createTime
    });
    await this.options.repository.insertLarkMessage({
      larkMessageId: message.messageId,
      eventId: message.eventId,
      larkUserId: message.senderOpenId,
      larkGroupId: message.larkGroupId,
      larkThreadId: message.larkThreadId,
      conversationKey,
      routeKind: route.routeKind,
      status: route.status,
      text: route.text,
      larkCreateTime: message.createTime,
      rawEventJson: safeJsonStringify(message.raw)
    });
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
      downloadedFiles.push(
        await this.options.larkFiles.downloadMessageResource({
          messageId: message.messageId,
          resourceType: resource.resourceType,
          fileKey: resource.fileKey,
          fileName: resource.fileName,
          outputDir
        })
      );
    }
    message.downloadedFiles = downloadedFiles;
    message.text = downloadedFiles.map((file) => formatDownloadedFileForCodex(file, message.messageType)).join("\n");
  }

  private async resolveSenderName(message: IncomingLarkMessage, role: RoleName): Promise<string | undefined> {
    const existing = await this.options.repository.getUserByLarkUserId(message.senderOpenId);
    const existingName = nonEmptyString(existing?.name);
    if (existingName) {
      return existingName;
    }

    const failureUntil = this.nameLookupFailureCache.get(message.senderOpenId) ?? 0;
    if (failureUntil > Date.now()) {
      return undefined;
    }
    this.nameLookupFailureCache.delete(message.senderOpenId);

    if (!this.options.larkUsers) {
      return undefined;
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
      return undefined;
    }
  }

  private cacheNameLookupFailure(larkUserId: string): void {
    this.nameLookupFailureCache.set(larkUserId, Date.now() + (this.options.nameLookupFailureTtlMs ?? 60_000));
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
      await this.markMessagesCompletedBestEffort([message.messageId]);
      return;
    }

    state.pendingBatch.push(toPendingMessage(message, text));
    if (!state.active) {
      await this.startPendingBatch(state, conversationKey);
    }
  }

  private async handleHelpCommand(message: IncomingLarkMessage): Promise<void> {
    await this.replyControlBestEffort(message.messageId, ConversationManager.helpText);
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async handleStatusCommand(
    state: ConversationState,
    conversationKey: string,
    message: IncomingLarkMessage
  ): Promise<void> {
    const role = roleForSender(this.options.config, message.senderOpenId);
    const conversation = await this.options.repository.findByConversationKey(conversationKey);
    const threadId = state.active?.threadId ?? conversation?.codexThreadId;
    const thread = threadId ? await this.options.repository.getCodexThreadById(threadId) : undefined;
    const lines = [
      `OUID: ${message.senderOpenId}`,
      `Conversation Key: ${conversationKey}`,
      `Codex Thread ID: ${threadId ?? "未创建"}`,
      ...formatThreadTokenStatus(thread)
    ];

    if (role === "owner") {
      lines.push(...(await this.formatOwnerRateLimitStatus(role)));
    }

    await this.replyControlBestEffort(message.messageId, lines.join("\n"));
    await this.markMessagesCompletedBestEffort([message.messageId]);
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
    const clearedMessages = this.clearPendingMessages(state);
    const cleared = clearedMessages.length;
    await this.markPendingMessagesClearedBestEffort(clearedMessages);
    const interrupted = await this.cancelActiveTurn(state);
    const summary = interrupted
      ? `已停止当前任务，清空 ${cleared} 条待处理消息。`
      : `当前没有正在运行的任务，清空 ${cleared} 条待处理消息。`;
    await this.replyControlBestEffort(message.messageId, summary);
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async handleNextCommand(
    state: ConversationState,
    conversationKey: string,
    message: IncomingLarkMessage
  ): Promise<void> {
    const queued = state.pendingBatch.length;
    const interrupted = await this.cancelActiveTurn(state, { waitForCompletion: true });
    if (!interrupted) {
      await this.startPendingBatch(state, conversationKey, { limit: 1 });
    }
    const summary = interrupted
      ? queued > 0
        ? `已打断当前任务，将执行队列中的下一条消息。队列剩余 ${Math.max(queued - 1, 0)} 条。`
        : "已打断当前任务，但队列为空。"
      : queued > 0
        ? `当前没有正在运行的任务，开始执行队列中的下一条消息。队列剩余 ${Math.max(queued - 1, 0)} 条。`
        : "当前没有正在运行的任务，队列为空。";
    await this.replyControlBestEffort(message.messageId, summary);
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async handleNewCommand(
    state: ConversationState,
    conversationKey: string,
    message: IncomingLarkMessage
  ): Promise<void> {
    await this.markPendingMessagesClearedBestEffort(this.clearPendingMessages(state));
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
    await this.recordCodexThreadBestEffort({
      conversationKey,
      codexThreadId: thread.threadId,
      role,
      larkThreadId: message.larkThreadId
    });
    await this.replyControlBestEffort(message.messageId, `已新开 Codex thread：${thread.threadId}`);
    await this.markMessagesCompletedBestEffort([message.messageId]);
  }

  private async steerOrDefer(
    state: ConversationState,
    active: ActiveTurn,
    message: PendingMessage
  ): Promise<void> {
    if (!active.turnId) {
      await this.markActiveProcessingMessagesSteered(active);
      active.pendingSteers.push(message);
      active.messageIds.add(message.messageId);
      active.processingMessageIds.add(message.messageId);
      await this.markMessagesProcessingBestEffort([message.messageId], {
        conversationKey: active.conversationKey,
        codexThreadId: active.threadId
      });
      active.replyMessageId = message.messageId;
      await this.moveReactionBestEffort(active, message.messageId);
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
      active.messageIds.add(message.messageId);
      active.processingMessageIds.add(message.messageId);
      await this.markMessagesProcessingBestEffort([message.messageId], {
        conversationKey: active.conversationKey,
        codexThreadId: active.threadId,
        codexTurnId: active.turnId
      });
      active.replyMessageId = message.messageId;
      await this.moveReactionBestEffort(active, message.messageId);
    } catch (error) {
      this.log.warn(
        { error, threadId: active.threadId, turnId: active.turnId, messageId: message.messageId },
        "failed to steer active codex turn; queueing message for next turn"
      );
      state.pendingBatch.push(message);
      await this.markPendingMessagesQueuedBestEffort([message]);
      await this.replyControlBestEffort(message.messageId, "当前任务已不可打断注入，已加入下一轮队列。");
    }
  }

  private async startPendingBatch(
    state: ConversationState,
    conversationKey: string,
    options: { limit?: number } = {}
  ): Promise<void> {
    if (state.active || state.pendingBatch.length === 0) {
      return;
    }
    const count = options.limit === undefined ? state.pendingBatch.length : Math.max(0, Math.min(options.limit, state.pendingBatch.length));
    const messages = state.pendingBatch.splice(0, count);
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
    await this.recordCodexThreadBestEffort({
      conversationKey,
      codexThreadId: activeThread.threadId,
      role,
      larkThreadId: anchor.original.larkThreadId
    });
    await this.beginActiveTurn(state, conversationKey, {
      messages,
      role,
      threadId: activeThread.threadId,
      workspace,
      input: messages.map(formatPendingMessageForCodex).join("\n")
    });
  }

  private async beginActiveTurn(
    state: ConversationState,
    conversationKey: string,
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
      conversationKey,
      codexThreadId: params.threadId
    });
    const active: ActiveTurn = {
      runId: ++state.nextRunId,
      role: params.role,
      threadId: params.threadId,
      workspace: params.workspace,
      conversationKey,
      replyMessageId: anchor.messageId,
      reaction: await this.addReactionBestEffort(anchor.messageId),
      pendingSteers: [],
      messageIds: new Set(params.messages.map((message) => message.messageId)),
      processingMessageIds: new Set(params.messages.map((message) => message.messageId)),
      steeredMessageIds: new Set(),
      cancelRequested: false
    };
    state.active = active;
    const startedAt = Date.now();

    void this.options.codex
      .startTurn({
        role: params.role,
        threadId: active.threadId,
        input: params.input,
        cwd: params.workspace,
        approvalPolicy: "never",
        onTurnStarted: (turnId) => this.handleTurnStarted(state, active, turnId),
        onAgentMessage: (agentMessage) => this.replyAgentMessageForActiveBestEffort(state, active, agentMessage),
        onTokenUsage: (usage) => this.recordThreadTokenUsageBestEffort(active, usage)
      })
      .then((result) => {
        active.completedStatus = result.status;
        this.log.info(
          {
            messageId: anchor.messageId,
            conversationKey,
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
          active.messageIds.delete(message.messageId);
          active.processingMessageIds.delete(message.messageId);
          active.steeredMessageIds.delete(message.messageId);
        }
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
          active.messageIds.delete(queued.messageId);
          active.processingMessageIds.delete(queued.messageId);
          active.steeredMessageIds.delete(queued.messageId);
        }
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
      return;
    }
    state.active = undefined;
    await this.clearReactionBestEffort(active);
    if (active.cancelRequested) {
      await this.startPendingBatch(state, conversationKey, { limit: 1 });
      return;
    }
    if (active.completedStatus === "completed") {
      await this.markMessagesCompletedBestEffort([...active.processingMessageIds]);
    } else {
      await this.markMessagesFailedBestEffort([...active.processingMessageIds]);
    }
    await this.addCompletedReactionBestEffort(active);
    await this.startPendingBatch(state, conversationKey);
  }

  private clearPendingMessages(state: ConversationState): PendingMessage[] {
    const batchPending = state.pendingBatch.splice(0);
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
  }): Promise<void> {
    try {
      await this.options.repository.upsertCodexThread(params);
    } catch (error) {
      this.log.warn({ error, codexThreadId: params.codexThreadId }, "failed to record codex thread");
    }
  }

  private async recordThreadTokenUsageBestEffort(
    active: ActiveTurn,
    usage: CodexThreadTokenUsageUpdate
  ): Promise<void> {
    try {
      await this.options.repository.updateCodexThreadTokenUsage({
        codexThreadId: usage.threadId,
        conversationKey: active.conversationKey,
        role: active.role,
        totalTokens: usage.totalTokens,
        tokenUsageJson: safeJsonStringify(usage.raw) ?? "{}"
      });
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

  private async addCompletedReactionBestEffort(active: ActiveTurn): Promise<void> {
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
    await this.replyAgentMessageBestEffort(active, active.replyMessageId, agentMessage);
  }

  private async replyAgentMessageBestEffort(
    active: ActiveTurn,
    messageId: string,
    agentMessage: { id: string; text: string }
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
  if (command === "status") {
    return { kind: "status" };
  }
  if (command === "new") {
    return { kind: "new" };
  }
  if (command === "help") {
    return { kind: "help" };
  }
  if (command === "queue") {
    return { kind: "queue", text: rest };
  }
  return { kind: "message", text };
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
    parsed.kind === "new" ||
    parsed.kind === "queue"
  ) {
    return { routeKind: "control_message", status: "processing", text: originalText };
  }
  if (state.pendingBatch.length > 0 || state.active?.cancelRequested) {
    return { routeKind: "queued_message", status: "queued", text: parsed.text };
  }
  if (state.active) {
    return { routeKind: "steered_message", status: "processing", text: parsed.text };
  }
  return { routeKind: "message", status: "processing", text: parsed.text };
}

function toPendingMessage(message: IncomingLarkMessage, text: string): PendingMessage {
  return {
    messageId: message.messageId,
    text,
    original: message
  };
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

interface RateLimitWindowStatus {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

function formatThreadTokenStatus(thread: CodexThreadRecord | undefined): string[] {
  const breakdown = extractThreadTokenBreakdown(thread);
  const cacheHitRate = breakdown.inputTokens > 0 ? breakdown.cachedInputTokens / breakdown.inputTokens : 0;
  return [
    "Thread Token Usage:",
    `- total: ${formatInteger(breakdown.totalTokens)}`,
    `- input: ${formatInteger(breakdown.inputTokens)}`,
    `- output: ${formatInteger(breakdown.outputTokens)}`,
    `- cached input: ${formatInteger(breakdown.cachedInputTokens)}`,
    `- reasoning output: ${formatInteger(breakdown.reasoningOutputTokens)}`,
    `- cache hit rate: ${formatPercent(cacheHitRate)}`
  ];
}

function extractThreadTokenBreakdown(thread: CodexThreadRecord | undefined): TokenBreakdown {
  const raw = parseStoredRawEvent(thread?.tokenUsageJson);
  const total = firstRecord(
    nestedRecord(raw, ["tokenUsage", "total"]),
    nestedRecord(raw, ["usage", "total"]),
    nestedRecord(raw, ["total"])
  );
  return {
    totalTokens: finiteNumber(total?.totalTokens, total?.total_tokens, thread?.totalTokens) ?? 0,
    inputTokens: finiteNumber(total?.inputTokens, total?.input_tokens) ?? 0,
    cachedInputTokens: finiteNumber(total?.cachedInputTokens, total?.cached_input_tokens) ?? 0,
    outputTokens: finiteNumber(total?.outputTokens, total?.output_tokens) ?? 0,
    reasoningOutputTokens: finiteNumber(total?.reasoningOutputTokens, total?.reasoning_output_tokens) ?? 0
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
  file: { path: string; resourceType: "image" | "file"; fileKey: string; size: number },
  messageType: string
): string {
  const tag = codexFileTagForMessage(file.resourceType, messageType);
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

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
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
