import path from "node:path";

import type Database from "better-sqlite3";

import { TwinnyError } from "../errors.js";
import type {
  CodexThreadRecord,
  ConversationRecord,
  ConversationType,
  LarkMessageRecord,
  LarkMessageRouteKind,
  LarkMessageStatus,
  NewConversationRecord,
  RoleName,
  UserRecord
} from "../types.js";
import { assertValidConversationKey, createP2PConversationKey } from "../workspace/slug.js";

interface ConversationRow {
  id: number;
  conversation_key: string;
  type: ConversationType;
  chat_id: string;
  name: string;
  role: RoleName;
  codex_thread_id: string;
  codex_thread_has_rollout: 0 | 1;
  workspace: string;
  role_codex_home: string;
  created_at: number;
  updated_at: number;
}

interface InsertConversationParams {
  conversationKey: string;
  type: ConversationType;
  chatId: string;
  name: string;
  role: RoleName;
  codexThreadId: string;
  codexThreadHasRollout: 0 | 1;
  workspace: string;
  roleCodexHome: string;
  createdAt: number;
  updatedAt: number;
}

interface UserRow {
  id: number;
  lark_user_id: string;
  name: string;
  role: RoleName;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
}

interface CodexThreadRow {
  id: number;
  codex_thread_id: string;
  conversation_key: string;
  lark_thread_id: string | null;
  role: RoleName;
  forked_from_codex_thread_id: string | null;
  forked_at: number | null;
  total_tokens: number;
  token_usage_json: string;
  created_at: number;
  updated_at: number;
}

interface LarkMessageRow {
  id: number;
  lark_message_id: string;
  event_id: string;
  lark_user_id: string;
  lark_group_id: string | null;
  lark_thread_id: string | null;
  conversation_key: string | null;
  codex_thread_id: string | null;
  codex_turn_id: string | null;
  route_kind: LarkMessageRouteKind;
  status: LarkMessageStatus;
  text: string;
  lark_create_time: number | null;
  received_at: number;
  updated_at: number;
  processing_started_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  cleared_at: number | null;
  raw_event_json: string | null;
}

export interface UpsertUserInput {
  larkUserId: string;
  name?: string;
  role?: RoleName;
  seenAt?: number;
}

export interface UpsertCodexThreadInput {
  codexThreadId: string;
  conversationKey: string;
  role: RoleName;
  larkThreadId?: string;
  forkedFromCodexThreadId?: string;
  forkedAt?: number;
}

export interface InsertLarkMessageInput {
  larkMessageId: string;
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
}

export interface UpdateCodexThreadTokenUsageInput {
  codexThreadId: string;
  conversationKey: string;
  role: RoleName;
  totalTokens: number;
  tokenUsageJson: string;
}

export interface UpdateConversationThreadBinding {
  codexThreadId: string;
  codexThreadHasRollout?: boolean;
  role?: RoleName;
  roleCodexHome?: string;
  workspace?: string;
}

export interface ConversationRepositoryOptions {
  now?: () => number;
}

export class ConversationRepository {
  private readonly now: () => number;

  private readonly insertConversation: Database.Statement<[InsertConversationParams]>;
  private readonly selectByConversationKey: Database.Statement<[string], ConversationRow>;
  private readonly selectByTypeAndChatId: Database.Statement<[ConversationType, string], ConversationRow>;
  private readonly selectByCodexThreadId: Database.Statement<[string], ConversationRow>;
  private readonly selectAll: Database.Statement<[], ConversationRow>;
  private readonly updateThread: Database.Statement<[
    string,
    0 | 1,
    RoleName,
    string,
    string,
    number,
    string
  ]>;
  private readonly markRollout: Database.Statement<[number, string, string]>;
  private readonly deleteByKey: Database.Statement<[string]>;
  private readonly upsertUserStatement: Database.Statement<[Record<string, unknown>]>;
  private readonly selectUserByLarkUserId: Database.Statement<[string], UserRow>;
  private readonly upsertCodexThreadStatement: Database.Statement<[Record<string, unknown>]>;
  private readonly selectCodexThreadById: Database.Statement<[string], CodexThreadRow>;
  private readonly updateCodexThreadUsageStatement: Database.Statement<[Record<string, unknown>]>;
  private readonly insertLarkMessageStatement: Database.Statement<[Record<string, unknown>]>;
  private readonly selectLarkMessageById: Database.Statement<[string], LarkMessageRow>;
  private readonly selectUnfinishedLarkMessages: Database.Statement<[], LarkMessageRow>;
  private readonly updateLarkMessageProcessingStatement: Database.Statement<[
    string | null,
    string | null,
    string | null,
    number,
    number,
    string
  ]>;
  private readonly updateLarkMessageSteeredStatement: Database.Statement<[
    string | null,
    string | null,
    string | null,
    number,
    string
  ]>;
  private readonly updateLarkMessageQueuedStatement: Database.Statement<[number, string]>;
  private readonly updateLarkMessageCompletedStatement: Database.Statement<[number, number, string]>;
  private readonly updateLarkMessageFailedStatement: Database.Statement<[number, number, string]>;
  private readonly updateLarkMessageInterruptedStatement: Database.Statement<[number, number, string]>;
  private readonly updateLarkMessageClearedStatement: Database.Statement<[number, number, string]>;

  constructor(
    private readonly db: Database.Database,
    options: ConversationRepositoryOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.insertConversation = this.db.prepare(`
      INSERT INTO conversations (
        conversation_key,
        type,
        chat_id,
        name,
        role,
        codex_thread_id,
        codex_thread_has_rollout,
        workspace,
        role_codex_home,
        created_at,
        updated_at
      ) VALUES (
        @conversationKey,
        @type,
        @chatId,
        @name,
        @role,
        @codexThreadId,
        @codexThreadHasRollout,
        @workspace,
        @roleCodexHome,
        @createdAt,
        @updatedAt
      )
    `);
    this.selectByConversationKey = this.db.prepare(`
      SELECT * FROM conversations WHERE conversation_key = ?
    `);
    this.selectByTypeAndChatId = this.db.prepare(`
      SELECT * FROM conversations WHERE type = ? AND chat_id = ?
    `);
    this.selectByCodexThreadId = this.db.prepare(`
      SELECT * FROM conversations WHERE codex_thread_id = ?
    `);
    this.selectAll = this.db.prepare(`
      SELECT * FROM conversations ORDER BY id ASC
    `);
    this.updateThread = this.db.prepare(`
      UPDATE conversations
      SET codex_thread_id = ?,
          codex_thread_has_rollout = ?,
          role = ?,
          role_codex_home = ?,
          workspace = ?,
          updated_at = ?
      WHERE conversation_key = ?
    `);
    this.markRollout = this.db.prepare(`
      UPDATE conversations
      SET codex_thread_has_rollout = 1,
          updated_at = ?
      WHERE conversation_key = ?
        AND codex_thread_id = ?
    `);
    this.deleteByKey = this.db.prepare(`
      DELETE FROM conversations WHERE conversation_key = ?
    `);
    this.upsertUserStatement = this.db.prepare(`
      INSERT INTO users (
        lark_user_id,
        name,
        role,
        created_at,
        updated_at,
        last_seen_at
      ) VALUES (
        @larkUserId,
        @name,
        @role,
        @createdAt,
        @updatedAt,
        @lastSeenAt
      )
      ON CONFLICT(lark_user_id) DO UPDATE SET
        name = CASE
          WHEN excluded.name <> '' THEN excluded.name
          ELSE users.name
        END,
        role = excluded.role,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
    `);
    this.selectUserByLarkUserId = this.db.prepare(`
      SELECT * FROM users WHERE lark_user_id = ?
    `);
    this.upsertCodexThreadStatement = this.db.prepare(`
      INSERT INTO codex_threads (
        codex_thread_id,
        conversation_key,
        lark_thread_id,
        role,
        forked_from_codex_thread_id,
        forked_at,
        total_tokens,
        token_usage_json,
        created_at,
        updated_at
      ) VALUES (
        @codexThreadId,
        @conversationKey,
        @larkThreadId,
        @role,
        @forkedFromCodexThreadId,
        @forkedAt,
        @totalTokens,
        @tokenUsageJson,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(codex_thread_id) DO UPDATE SET
        conversation_key = excluded.conversation_key,
        lark_thread_id = COALESCE(excluded.lark_thread_id, codex_threads.lark_thread_id),
        role = excluded.role,
        forked_from_codex_thread_id = COALESCE(excluded.forked_from_codex_thread_id, codex_threads.forked_from_codex_thread_id),
        forked_at = COALESCE(excluded.forked_at, codex_threads.forked_at),
        updated_at = excluded.updated_at
    `);
    this.selectCodexThreadById = this.db.prepare(`
      SELECT * FROM codex_threads WHERE codex_thread_id = ?
    `);
    this.updateCodexThreadUsageStatement = this.db.prepare(`
      INSERT INTO codex_threads (
        codex_thread_id,
        conversation_key,
        lark_thread_id,
        role,
        total_tokens,
        token_usage_json,
        created_at,
        updated_at
      ) VALUES (
        @codexThreadId,
        @conversationKey,
        NULL,
        @role,
        @totalTokens,
        @tokenUsageJson,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(codex_thread_id) DO UPDATE SET
        conversation_key = excluded.conversation_key,
        role = excluded.role,
        total_tokens = excluded.total_tokens,
        token_usage_json = excluded.token_usage_json,
        updated_at = excluded.updated_at
    `);
    this.insertLarkMessageStatement = this.db.prepare(`
      INSERT OR IGNORE INTO lark_messages (
        lark_message_id,
        event_id,
        lark_user_id,
        lark_group_id,
        lark_thread_id,
        conversation_key,
        codex_thread_id,
        codex_turn_id,
        route_kind,
        status,
        text,
        lark_create_time,
        received_at,
        updated_at,
        raw_event_json
      ) VALUES (
        @larkMessageId,
        @eventId,
        @larkUserId,
        @larkGroupId,
        @larkThreadId,
        @conversationKey,
        @codexThreadId,
        @codexTurnId,
        @routeKind,
        @status,
        @text,
        @larkCreateTime,
        @receivedAt,
        @updatedAt,
        @rawEventJson
      )
    `);
    this.selectLarkMessageById = this.db.prepare(`
      SELECT * FROM lark_messages WHERE lark_message_id = ?
    `);
    this.selectUnfinishedLarkMessages = this.db.prepare(`
      SELECT * FROM lark_messages
      WHERE status IN ('processing', 'queued')
      ORDER BY received_at ASC, id ASC
    `);
    this.updateLarkMessageProcessingStatement = this.db.prepare(`
      UPDATE lark_messages
      SET status = 'processing',
          conversation_key = COALESCE(?, conversation_key),
          codex_thread_id = COALESCE(?, codex_thread_id),
          codex_turn_id = COALESCE(?, codex_turn_id),
          processing_started_at = COALESCE(processing_started_at, ?),
          updated_at = ?
      WHERE lark_message_id = ?
    `);
    this.updateLarkMessageQueuedStatement = this.db.prepare(`
      UPDATE lark_messages
      SET route_kind = 'queued_message',
          status = 'queued',
          codex_thread_id = NULL,
          codex_turn_id = NULL,
          updated_at = ?
      WHERE lark_message_id = ?
    `);
    this.updateLarkMessageSteeredStatement = this.db.prepare(`
      UPDATE lark_messages
      SET status = 'steered',
          conversation_key = COALESCE(?, conversation_key),
          codex_thread_id = COALESCE(?, codex_thread_id),
          codex_turn_id = COALESCE(?, codex_turn_id),
          updated_at = ?
      WHERE lark_message_id = ?
    `);
    this.updateLarkMessageCompletedStatement = this.db.prepare(`
      UPDATE lark_messages
      SET status = 'completed',
          completed_at = COALESCE(completed_at, ?),
          updated_at = ?
      WHERE lark_message_id = ?
    `);
    this.updateLarkMessageFailedStatement = this.db.prepare(`
      UPDATE lark_messages
      SET status = 'failed',
          failed_at = COALESCE(failed_at, ?),
          updated_at = ?
      WHERE lark_message_id = ?
    `);
    this.updateLarkMessageInterruptedStatement = this.db.prepare(`
      UPDATE lark_messages
      SET status = 'interrupted',
          failed_at = COALESCE(failed_at, ?),
          updated_at = ?
      WHERE lark_message_id = ?
    `);
    this.updateLarkMessageClearedStatement = this.db.prepare(`
      UPDATE lark_messages
      SET status = 'cleared',
          cleared_at = COALESCE(cleared_at, ?),
          updated_at = ?
      WHERE lark_message_id = ?
    `);
  }

  create(input: NewConversationRecord): ConversationRecord {
    const params = this.toInsertParams(input);
    const create = this.db.transaction(() => {
      this.insertConversation.run(params);
      return this.requireByConversationKey(params.conversationKey);
    });
    return create();
  }

  getOrCreate(input: NewConversationRecord): ConversationRecord {
    const params = this.toInsertParams(input);
    const getOrCreate = this.db.transaction(() => {
      const existing = this.getByConversationKey(params.conversationKey);
      if (existing) {
        return existing;
      }
      this.insertConversation.run(params);
      return this.requireByConversationKey(params.conversationKey);
    });
    return getOrCreate();
  }

  getByConversationKey(conversationKey: string): ConversationRecord | undefined {
    assertValidConversationKey(conversationKey);
    return mapConversationRow(this.selectByConversationKey.get(conversationKey));
  }

  getByTypeAndChatId(type: ConversationType, chatId: string): ConversationRecord | undefined {
    assertValidConversationType(type);
    assertExpectedP2PConversationKey(createP2PConversationKey(chatId), type, chatId);
    return mapConversationRow(this.selectByTypeAndChatId.get(type, chatId));
  }

  getByCodexThreadId(codexThreadId: string): ConversationRecord | undefined {
    assertNonEmpty(codexThreadId, "codexThreadId");
    return mapConversationRow(this.selectByCodexThreadId.get(codexThreadId));
  }

  list(): ConversationRecord[] {
    return this.selectAll.all().map((row) => mapRequiredConversationRow(row));
  }

  updateThreadBinding(conversationKey: string, update: UpdateConversationThreadBinding): ConversationRecord {
    assertValidConversationKey(conversationKey);
    assertNonEmpty(update.codexThreadId, "codexThreadId");
    if (update.role !== undefined) {
      assertValidRole(update.role);
    }
    if (update.roleCodexHome !== undefined) {
      assertNonEmpty(update.roleCodexHome, "roleCodexHome");
    }
    if (update.workspace !== undefined) {
      assertAbsolutePath(update.workspace, "workspace");
    }

    const updateBinding = this.db.transaction(() => {
      const existing = this.requireByConversationKey(conversationKey);
      const role = update.role ?? existing.role;
      const roleCodexHome = update.roleCodexHome ?? existing.roleCodexHome;
      const workspace = update.workspace ?? existing.workspace;
      const codexThreadHasRollout = update.codexThreadHasRollout ?? existing.codexThreadHasRollout;
      this.updateThread.run(
        update.codexThreadId,
        codexThreadHasRollout ? 1 : 0,
        role,
        roleCodexHome,
        workspace,
        this.now(),
        conversationKey
      );
      return this.requireByConversationKey(conversationKey);
    });

    return updateBinding();
  }

  markThreadHasRollout(conversationKey: string, codexThreadId: string): void {
    assertValidConversationKey(conversationKey);
    assertNonEmpty(codexThreadId, "codexThreadId");
    this.markRollout.run(this.now(), conversationKey, codexThreadId);
  }

  deleteByConversationKey(conversationKey: string): boolean {
    assertValidConversationKey(conversationKey);
    const remove = this.db.transaction(() => this.deleteByKey.run(conversationKey).changes > 0);
    return remove();
  }

  upsertUser(input: UpsertUserInput): UserRecord {
    assertNonEmpty(input.larkUserId, "larkUserId");
    const role = input.role ?? "guest";
    assertValidRole(role);
    const now = this.now();
    this.upsertUserStatement.run({
      larkUserId: input.larkUserId,
      name: input.name ?? "",
      role,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: input.seenAt ?? now
    });
    return this.requireUserByLarkUserId(input.larkUserId);
  }

  getUserByLarkUserId(larkUserId: string): UserRecord | undefined {
    assertNonEmpty(larkUserId, "larkUserId");
    return mapUserRow(this.selectUserByLarkUserId.get(larkUserId));
  }

  upsertCodexThread(input: UpsertCodexThreadInput): CodexThreadRecord {
    validateCodexThreadInput(input);
    const now = this.now();
    this.upsertCodexThreadStatement.run({
      codexThreadId: input.codexThreadId,
      conversationKey: input.conversationKey,
      larkThreadId: input.larkThreadId ?? null,
      role: input.role,
      forkedFromCodexThreadId: input.forkedFromCodexThreadId ?? null,
      forkedAt: input.forkedAt ?? null,
      totalTokens: 0,
      tokenUsageJson: "{}",
      createdAt: now,
      updatedAt: now
    });
    return this.requireCodexThreadById(input.codexThreadId);
  }

  getCodexThreadById(codexThreadId: string): CodexThreadRecord | undefined {
    assertNonEmpty(codexThreadId, "codexThreadId");
    return mapCodexThreadRow(this.selectCodexThreadById.get(codexThreadId));
  }

  updateCodexThreadTokenUsage(input: UpdateCodexThreadTokenUsageInput): CodexThreadRecord {
    assertNonEmpty(input.codexThreadId, "codexThreadId");
    assertValidConversationKey(input.conversationKey);
    assertValidRole(input.role);
    if (!Number.isFinite(input.totalTokens) || input.totalTokens < 0) {
      throw new TwinnyError("totalTokens must be a non-negative finite number", "CODEX_THREAD_TOKEN_USAGE_INVALID");
    }
    assertNonEmpty(input.tokenUsageJson, "tokenUsageJson");
    const now = this.now();
    this.updateCodexThreadUsageStatement.run({
      codexThreadId: input.codexThreadId,
      conversationKey: input.conversationKey,
      role: input.role,
      totalTokens: Math.trunc(input.totalTokens),
      tokenUsageJson: input.tokenUsageJson,
      createdAt: now,
      updatedAt: now
    });
    return this.requireCodexThreadById(input.codexThreadId);
  }

  insertLarkMessage(input: InsertLarkMessageInput): LarkMessageRecord {
    validateLarkMessageInput(input);
    const now = this.now();
    this.insertLarkMessageStatement.run({
      larkMessageId: input.larkMessageId,
      eventId: input.eventId,
      larkUserId: input.larkUserId,
      larkGroupId: input.larkGroupId ?? null,
      larkThreadId: input.larkThreadId ?? null,
      conversationKey: input.conversationKey ?? null,
      codexThreadId: input.codexThreadId ?? null,
      codexTurnId: input.codexTurnId ?? null,
      routeKind: input.routeKind,
      status: input.status,
      text: input.text,
      larkCreateTime: input.larkCreateTime ?? null,
      receivedAt: now,
      updatedAt: now,
      rawEventJson: input.rawEventJson ?? null
    });
    return this.requireLarkMessageById(input.larkMessageId);
  }

  getLarkMessageById(larkMessageId: string): LarkMessageRecord | undefined {
    assertNonEmpty(larkMessageId, "larkMessageId");
    return mapLarkMessageRow(this.selectLarkMessageById.get(larkMessageId));
  }

  listUnfinishedLarkMessages(): LarkMessageRecord[] {
    return this.selectUnfinishedLarkMessages.all().map((row) => mapRequiredLarkMessageRow(row));
  }

  markLarkMessageQueued(larkMessageId: string): void {
    assertNonEmpty(larkMessageId, "larkMessageId");
    this.updateLarkMessageQueuedStatement.run(this.now(), larkMessageId);
  }

  markLarkMessagesProcessing(
    larkMessageIds: string[],
    update: { conversationKey?: string; codexThreadId?: string; codexTurnId?: string } = {}
  ): void {
    validateLarkMessageIds(larkMessageIds);
    validateLarkMessageBindingUpdate(update);
    const now = this.now();
    const mark = this.db.transaction(() => {
      for (const messageId of larkMessageIds) {
        this.updateLarkMessageProcessingStatement.run(
          update.conversationKey ?? null,
          update.codexThreadId ?? null,
          update.codexTurnId ?? null,
          now,
          now,
          messageId
        );
      }
    });
    mark();
  }

  markLarkMessagesSteered(
    larkMessageIds: string[],
    update: { conversationKey?: string; codexThreadId?: string; codexTurnId?: string } = {}
  ): void {
    validateLarkMessageIds(larkMessageIds);
    validateLarkMessageBindingUpdate(update);
    const now = this.now();
    const mark = this.db.transaction(() => {
      for (const messageId of larkMessageIds) {
        this.updateLarkMessageSteeredStatement.run(
          update.conversationKey ?? null,
          update.codexThreadId ?? null,
          update.codexTurnId ?? null,
          now,
          messageId
        );
      }
    });
    mark();
  }

  markLarkMessagesCompleted(larkMessageIds: string[]): void {
    this.markLarkMessagesTerminal(larkMessageIds, this.updateLarkMessageCompletedStatement);
  }

  markLarkMessagesFailed(larkMessageIds: string[]): void {
    this.markLarkMessagesTerminal(larkMessageIds, this.updateLarkMessageFailedStatement);
  }

  markLarkMessagesInterrupted(larkMessageIds: string[]): void {
    this.markLarkMessagesTerminal(larkMessageIds, this.updateLarkMessageInterruptedStatement);
  }

  markLarkMessagesCleared(larkMessageIds: string[]): void {
    this.markLarkMessagesTerminal(larkMessageIds, this.updateLarkMessageClearedStatement);
  }

  private requireByConversationKey(conversationKey: string): ConversationRecord {
    const record = this.getByConversationKey(conversationKey);
    if (!record) {
      throw new TwinnyError(`Conversation ${conversationKey} was not found`, "CONVERSATION_NOT_FOUND");
    }
    return record;
  }

  private toInsertParams(input: NewConversationRecord): InsertConversationParams {
    validateNewConversation(input);
    const now = this.now();
    return {
      conversationKey: input.conversationKey,
      type: input.type,
      chatId: input.chatId,
      name: input.name,
      role: input.role,
      codexThreadId: input.codexThreadId,
      codexThreadHasRollout: input.codexThreadHasRollout === false ? 0 : 1,
      workspace: input.workspace,
      roleCodexHome: input.roleCodexHome,
      createdAt: now,
      updatedAt: now
    };
  }

  private requireUserByLarkUserId(larkUserId: string): UserRecord {
    const record = this.getUserByLarkUserId(larkUserId);
    if (!record) {
      throw new TwinnyError(`User ${larkUserId} was not found`, "USER_NOT_FOUND");
    }
    return record;
  }

  private requireCodexThreadById(codexThreadId: string): CodexThreadRecord {
    const record = this.getCodexThreadById(codexThreadId);
    if (!record) {
      throw new TwinnyError(`Codex thread ${codexThreadId} was not found`, "CODEX_THREAD_NOT_FOUND");
    }
    return record;
  }

  private requireLarkMessageById(larkMessageId: string): LarkMessageRecord {
    const record = this.getLarkMessageById(larkMessageId);
    if (!record) {
      throw new TwinnyError(`Lark message ${larkMessageId} was not found`, "LARK_MESSAGE_NOT_FOUND");
    }
    return record;
  }

  private markLarkMessagesTerminal(
    larkMessageIds: string[],
    statement: Database.Statement<[number, number, string]>
  ): void {
    for (const messageId of larkMessageIds) {
      assertNonEmpty(messageId, "larkMessageId");
    }
    const now = this.now();
    const mark = this.db.transaction(() => {
      for (const messageId of larkMessageIds) {
        statement.run(now, now, messageId);
      }
    });
    mark();
  }
}

export function createConversationRepository(
  db: Database.Database,
  options: ConversationRepositoryOptions = {}
): ConversationRepository {
  return new ConversationRepository(db, options);
}

function mapConversationRow(row: ConversationRow | undefined): ConversationRecord | undefined {
  if (!row) {
    return undefined;
  }

  return mapRequiredConversationRow(row);
}

function mapRequiredConversationRow(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    conversationKey: row.conversation_key,
    type: row.type,
    chatId: row.chat_id,
    name: row.name,
    role: row.role,
    codexThreadId: row.codex_thread_id,
    codexThreadHasRollout: row.codex_thread_has_rollout === 1,
    workspace: row.workspace,
    roleCodexHome: row.role_codex_home,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapUserRow(row: UserRow | undefined): UserRecord | undefined {
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    larkUserId: row.lark_user_id,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at
  };
}

function mapCodexThreadRow(row: CodexThreadRow | undefined): CodexThreadRecord | undefined {
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    codexThreadId: row.codex_thread_id,
    conversationKey: row.conversation_key,
    larkThreadId: row.lark_thread_id ?? undefined,
    role: row.role,
    forkedFromCodexThreadId: row.forked_from_codex_thread_id ?? undefined,
    forkedAt: row.forked_at ?? undefined,
    totalTokens: row.total_tokens,
    tokenUsageJson: row.token_usage_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapLarkMessageRow(row: LarkMessageRow | undefined): LarkMessageRecord | undefined {
  if (!row) {
    return undefined;
  }
  return mapRequiredLarkMessageRow(row);
}

function mapRequiredLarkMessageRow(row: LarkMessageRow): LarkMessageRecord {
  return {
    id: row.id,
    larkMessageId: row.lark_message_id,
    eventId: row.event_id,
    larkUserId: row.lark_user_id,
    larkGroupId: row.lark_group_id ?? undefined,
    larkThreadId: row.lark_thread_id ?? undefined,
    conversationKey: row.conversation_key ?? undefined,
    codexThreadId: row.codex_thread_id ?? undefined,
    codexTurnId: row.codex_turn_id ?? undefined,
    routeKind: row.route_kind,
    status: row.status,
    text: row.text,
    larkCreateTime: row.lark_create_time ?? undefined,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    processingStartedAt: row.processing_started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    clearedAt: row.cleared_at ?? undefined,
    rawEventJson: row.raw_event_json ?? undefined
  };
}

function validateNewConversation(input: NewConversationRecord): void {
  assertExpectedP2PConversationKey(input.conversationKey, input.type, input.chatId);
  assertNonEmpty(input.name, "name");
  assertValidRole(input.role);
  assertNonEmpty(input.codexThreadId, "codexThreadId");
  assertAbsolutePath(input.workspace, "workspace");
  assertNonEmpty(input.roleCodexHome, "roleCodexHome");
}

function validateCodexThreadInput(input: UpsertCodexThreadInput): void {
  assertNonEmpty(input.codexThreadId, "codexThreadId");
  assertValidConversationKey(input.conversationKey);
  assertValidRole(input.role);
  if (input.larkThreadId !== undefined) {
    assertNonEmpty(input.larkThreadId, "larkThreadId");
  }
  if (input.forkedFromCodexThreadId !== undefined) {
    assertNonEmpty(input.forkedFromCodexThreadId, "forkedFromCodexThreadId");
  }
}

function validateLarkMessageInput(input: InsertLarkMessageInput): void {
  assertNonEmpty(input.larkMessageId, "larkMessageId");
  assertNonEmpty(input.eventId, "eventId");
  assertNonEmpty(input.larkUserId, "larkUserId");
  assertValidRouteKind(input.routeKind);
  assertValidMessageStatus(input.status);
  if (input.conversationKey !== undefined) {
    assertValidConversationKey(input.conversationKey);
  }
  if (input.codexThreadId !== undefined) {
    assertNonEmpty(input.codexThreadId, "codexThreadId");
  }
  if (input.codexTurnId !== undefined) {
    assertNonEmpty(input.codexTurnId, "codexTurnId");
  }
}

function assertExpectedP2PConversationKey(conversationKey: string, type: ConversationType, chatId: string): void {
  assertValidConversationType(type);
  const expectedKey = createP2PConversationKey(chatId);
  if (conversationKey !== expectedKey) {
    throw new TwinnyError(
      `P2P conversation key must be ${expectedKey}, received ${conversationKey}`,
      "CONVERSATION_KEY_MISMATCH"
    );
  }
}

function assertValidConversationType(type: ConversationType): void {
  if (type !== "p2p") {
    throw new TwinnyError(`Unsupported conversation type: ${type}`, "CONVERSATION_TYPE_INVALID");
  }
}

function assertValidRole(role: RoleName): void {
  if (role !== "owner" && role !== "guest") {
    throw new TwinnyError(`Unsupported role: ${role}`, "CONVERSATION_ROLE_INVALID");
  }
}

function assertValidRouteKind(routeKind: LarkMessageRouteKind): void {
  if (
    routeKind !== "message" &&
    routeKind !== "steered_message" &&
    routeKind !== "queued_message" &&
    routeKind !== "control_message"
  ) {
    throw new TwinnyError(`Unsupported Lark message route kind: ${routeKind}`, "LARK_MESSAGE_ROUTE_KIND_INVALID");
  }
}

function assertValidMessageStatus(status: LarkMessageStatus): void {
  if (
    status !== "queued" &&
    status !== "processing" &&
    status !== "steered" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "interrupted" &&
    status !== "cleared"
  ) {
    throw new TwinnyError(`Unsupported Lark message status: ${status}`, "LARK_MESSAGE_STATUS_INVALID");
  }
}

function validateLarkMessageIds(larkMessageIds: string[]): void {
  for (const messageId of larkMessageIds) {
    assertNonEmpty(messageId, "larkMessageId");
  }
}

function validateLarkMessageBindingUpdate(update: {
  conversationKey?: string;
  codexThreadId?: string;
  codexTurnId?: string;
}): void {
  if (update.conversationKey !== undefined) {
    assertValidConversationKey(update.conversationKey);
  }
  if (update.codexThreadId !== undefined) {
    assertNonEmpty(update.codexThreadId, "codexThreadId");
  }
  if (update.codexTurnId !== undefined) {
    assertNonEmpty(update.codexTurnId, "codexTurnId");
  }
}

function assertAbsolutePath(value: string, field: string): void {
  assertNonEmpty(value, field);
  if (!path.isAbsolute(value)) {
    throw new TwinnyError(`${field} must be an absolute path`, "CONVERSATION_PATH_INVALID");
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new TwinnyError(`${field} must not be empty`, "CONVERSATION_FIELD_EMPTY");
  }
}
