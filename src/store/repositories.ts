import path from "node:path";

import type Database from "better-sqlite3";

import { TwinnyError } from "../errors.js";
import type {
  CodexThreadRecord,
  CodexThreadGoalStatus,
  CodexThreadMode,
  CodexThreadStatus,
  ConversationResponseMode,
  ConversationRecord,
  ConversationType,
  LarkMessageRecord,
  LarkMessageRouteKind,
  LarkMessageStatus,
  NewConversationRecord,
  RoleName
} from "../types.js";
import { assertValidConversationKey, createGroupConversationKey, createP2PConversationKey } from "../workspace/slug.js";

interface ConversationRow {
  id: number;
  conversation_key: string;
  type: ConversationType;
  chat_id: string;
  name: string;
  response_mode: ConversationResponseMode;
  role: RoleName;
  thread_id: string;
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
  responseMode: ConversationResponseMode;
  role: RoleName;
  codexThreadId: string;
  workspace: string;
  roleCodexHome: string;
  createdAt: number;
  updatedAt: number;
}

interface CodexThreadRow {
  id: number;
  thread_id: string;
  conversation_key: string;
  name: string;
  lark_thread_id: string | null;
  role: RoleName;
  mode: CodexThreadMode;
  status: CodexThreadStatus;
  goal_status: CodexThreadGoalStatus;
  goal_updated_at: number | null;
  forked_from_thread_id: string | null;
  forked_at: number | null;
  creator_open_id: string | null;
  card_message_id: string | null;
  thread_has_rollout: 0 | 1;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  context_tokens: number;
  context_window: number;
  token_usage_json: string;
  created_at: number;
  updated_at: number;
}

interface CodexThreadWorkStatsRow {
  turn_count: number;
  total_work_duration_ms: number | null;
}

interface CodexThreadStatusStatsRow extends CodexThreadWorkStatsRow {
  user_message_count: number;
}

interface ConversationStatusStatsRow {
  topic_count: number;
  user_message_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
  total_work_duration_ms: number | null;
}

interface LarkMessageRow {
  id: number;
  lark_message_id: string | null;
  event_id: string;
  lark_user_id: string;
  lark_group_id: string | null;
  lark_thread_id: string | null;
  conversation_key: string | null;
  thread_id: string | null;
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
  side_id: number | null;
  agent_card_message_id: string | null;
  raw_event_json: string | null;
}

export interface UpsertCodexThreadInput {
  codexThreadId: string;
  conversationKey: string;
  role: RoleName;
  name?: string;
  larkThreadId?: string;
  codexThreadHasRollout?: boolean;
  forkedFromCodexThreadId?: string;
  forkedAt?: number;
}

export interface InsertLarkMessageInput {
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
  sideId?: number;
  agentCardMessageId?: string;
  rawEventJson?: string;
}

export interface UpdateCodexThreadTokenUsageInput {
  codexThreadId: string;
  conversationKey: string;
  role: RoleName;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  contextTokens: number;
  contextWindow: number;
  tokenUsageJson: string;
}

export interface UpdateCodexThreadGoalStatusInput {
  codexThreadId: string;
  goalStatus: CodexThreadGoalStatus;
  goalUpdatedAt?: number;
}

export interface UpdateCodexThreadCardInput {
  codexThreadId: string;
  conversationKey: string;
  role: RoleName;
  name?: string;
  larkThreadId?: string;
  creatorOpenId?: string;
  cardMessageId?: string;
}

export interface CodexThreadWorkStats {
  turnCount: number;
  totalWorkDurationMs: number;
}

export interface CodexThreadStatusStats extends CodexThreadWorkStats {
  userMessageCount: number;
}

export interface ConversationStatusStats {
  topicCount: number;
  userMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  totalWorkDurationMs: number;
}

export interface ReplaceCodexThreadForLarkThreadInput {
  conversationKey: string;
  larkThreadId: string;
  codexThreadId: string;
  role: RoleName;
  codexThreadHasRollout?: boolean;
}

export interface UpdateConversationThreadBinding {
  codexThreadId: string;
  role?: RoleName;
  roleCodexHome?: string;
  workspace?: string;
}

export interface UpdateConversationSettingsInput {
  type?: ConversationType;
  name?: string;
  responseMode?: ConversationResponseMode;
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
  private readonly updateSettings: Database.Statement<[ConversationType, string, string, number, string]>;
  private readonly updateThread: Database.Statement<[
    string,
    RoleName,
    string,
    string,
    number,
    string
  ]>;
  private readonly markCodexThreadRollout: Database.Statement<[number, string, string]>;
  private readonly deleteByKey: Database.Statement<[string]>;
  private readonly upsertCodexThreadStatement: Database.Statement<[Record<string, unknown>]>;
  private readonly selectCodexThreadById: Database.Statement<[string], CodexThreadRow>;
  private readonly selectCodexThreadByConversationAndLarkThread: Database.Statement<[string, string], CodexThreadRow>;
  private readonly replaceCodexThreadForLarkThreadStatement: Database.Statement<[Record<string, unknown>]>;
  private readonly updateCodexThreadUsageStatement: Database.Statement<[Record<string, unknown>]>;
  private readonly updateCodexThreadCardStatement: Database.Statement<[Record<string, unknown>]>;
  private readonly updateCodexThreadNameStatement: Database.Statement<[string, number, string]>;
  private readonly updateCodexThreadModeStatement: Database.Statement<[CodexThreadMode, number, string, string]>;
  private readonly updateCodexThreadStatusStatement: Database.Statement<[CodexThreadStatus, number, string, string]>;
  private readonly updateCodexThreadGoalStatusStatement: Database.Statement<[CodexThreadGoalStatus, number | null, number, string]>;
  private readonly selectCodexThreadWorkStats: Database.Statement<[string], CodexThreadWorkStatsRow>;
  private readonly selectCodexThreadStatusStats: Database.Statement<[Record<string, unknown>], CodexThreadStatusStatsRow>;
  private readonly selectConversationStatusStats: Database.Statement<[Record<string, unknown>], ConversationStatusStatsRow>;
  private readonly insertLarkMessageStatement: Database.Statement<[Record<string, unknown>]>;
  private readonly selectLarkMessageById: Database.Statement<[string], LarkMessageRow>;
  private readonly selectLarkMessageByEventId: Database.Statement<[string], LarkMessageRow>;
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
  private readonly updateQueuedLarkMessageStatement: Database.Statement<[string, string | null, number, string]>;
  private readonly updateLarkMessageSideMetadataStatement: Database.Statement<[number | null, string | null, number, string]>;
  private readonly updateLarkMessageRecalledStatement: Database.Statement<[number, string]>;
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
        response_mode,
        role,
        thread_id,
        workspace,
        role_codex_home,
        created_at,
        updated_at
      ) VALUES (
        @conversationKey,
        @type,
        @chatId,
        @name,
        @responseMode,
        @role,
        @codexThreadId,
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
      SELECT * FROM conversations WHERE thread_id = ?
    `);
    this.selectAll = this.db.prepare(`
      SELECT * FROM conversations ORDER BY id ASC
    `);
    this.updateSettings = this.db.prepare(`
      UPDATE conversations
      SET type = ?,
          name = ?,
          response_mode = ?,
          updated_at = ?
      WHERE conversation_key = ?
    `);
    this.updateThread = this.db.prepare(`
      UPDATE conversations
      SET thread_id = ?,
          role = ?,
          role_codex_home = ?,
          workspace = ?,
          updated_at = ?
      WHERE conversation_key = ?
    `);
    this.markCodexThreadRollout = this.db.prepare(`
      UPDATE threads
      SET thread_has_rollout = 1,
          updated_at = ?
      WHERE conversation_key = ?
        AND thread_id = ?
    `);
    this.deleteByKey = this.db.prepare(`
      DELETE FROM conversations WHERE conversation_key = ?
    `);
    this.upsertCodexThreadStatement = this.db.prepare(`
      INSERT INTO threads (
        thread_id,
        conversation_key,
        name,
        lark_thread_id,
        role,
        forked_from_thread_id,
        forked_at,
        thread_has_rollout,
        total_tokens,
        token_usage_json,
        created_at,
        updated_at
      ) VALUES (
        @codexThreadId,
        @conversationKey,
        COALESCE(@name, '新会话'),
        @larkThreadId,
        @role,
        @forkedFromCodexThreadId,
        @forkedAt,
        @codexThreadHasRollout,
        @totalTokens,
        @tokenUsageJson,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_key = excluded.conversation_key,
        name = COALESCE(@name, threads.name),
        lark_thread_id = COALESCE(excluded.lark_thread_id, threads.lark_thread_id),
        role = excluded.role,
        forked_from_thread_id = COALESCE(excluded.forked_from_thread_id, threads.forked_from_thread_id),
        forked_at = COALESCE(excluded.forked_at, threads.forked_at),
        thread_has_rollout = CASE
          WHEN threads.thread_has_rollout = 1 OR excluded.thread_has_rollout = 1 THEN 1
          ELSE 0
        END,
        updated_at = excluded.updated_at
    `);
    this.selectCodexThreadById = this.db.prepare(`
      SELECT * FROM threads WHERE thread_id = ?
    `);
    this.selectCodexThreadByConversationAndLarkThread = this.db.prepare(`
      SELECT * FROM threads
      WHERE conversation_key = ?
        AND lark_thread_id = ?
    `);
    this.replaceCodexThreadForLarkThreadStatement = this.db.prepare(`
      UPDATE threads
      SET thread_id = @codexThreadId,
          role = @role,
          input_tokens = 0,
          output_tokens = 0,
          cached_input_tokens = 0,
          reasoning_output_tokens = 0,
          total_tokens = 0,
          context_tokens = 0,
          context_window = 0,
          thread_has_rollout = @codexThreadHasRollout,
          token_usage_json = '{}',
          goal_status = 'none',
          goal_updated_at = NULL,
          updated_at = @updatedAt
      WHERE conversation_key = @conversationKey
        AND lark_thread_id = @larkThreadId
    `);
    this.updateCodexThreadUsageStatement = this.db.prepare(`
      INSERT INTO threads (
        thread_id,
        conversation_key,
        name,
        lark_thread_id,
        role,
        input_tokens,
        output_tokens,
        cached_input_tokens,
        reasoning_output_tokens,
        total_tokens,
        context_tokens,
        context_window,
        thread_has_rollout,
        token_usage_json,
        created_at,
        updated_at
      ) VALUES (
        @codexThreadId,
        @conversationKey,
        COALESCE(@name, '新会话'),
        NULL,
        @role,
        @inputTokens,
        @outputTokens,
        @cachedInputTokens,
        @reasoningOutputTokens,
        @totalTokens,
        @contextTokens,
        @contextWindow,
        1,
        @tokenUsageJson,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_key = excluded.conversation_key,
        name = COALESCE(@name, threads.name),
        role = excluded.role,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        total_tokens = excluded.total_tokens,
        context_tokens = excluded.context_tokens,
        context_window = excluded.context_window,
        thread_has_rollout = 1,
        token_usage_json = excluded.token_usage_json,
        updated_at = excluded.updated_at
    `);
    this.updateCodexThreadCardStatement = this.db.prepare(`
      INSERT INTO threads (
        thread_id,
        conversation_key,
        name,
        lark_thread_id,
        role,
        creator_open_id,
        card_message_id,
        thread_has_rollout,
        created_at,
        updated_at
      ) VALUES (
        @codexThreadId,
        @conversationKey,
        COALESCE(@name, '新会话'),
        @larkThreadId,
        @role,
        @creatorOpenId,
        @cardMessageId,
        0,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_key = excluded.conversation_key,
        name = COALESCE(@name, threads.name),
        lark_thread_id = COALESCE(excluded.lark_thread_id, threads.lark_thread_id),
        role = excluded.role,
        creator_open_id = COALESCE(excluded.creator_open_id, threads.creator_open_id),
        card_message_id = COALESCE(excluded.card_message_id, threads.card_message_id),
        updated_at = excluded.updated_at
    `);
    this.updateCodexThreadNameStatement = this.db.prepare(`
      UPDATE threads
      SET name = ?,
          updated_at = ?
      WHERE thread_id = ?
    `);
    this.updateCodexThreadModeStatement = this.db.prepare(`
      UPDATE threads
      SET mode = ?,
          updated_at = ?
      WHERE conversation_key = ?
        AND thread_id = ?
    `);
    this.updateCodexThreadStatusStatement = this.db.prepare(`
      UPDATE threads
      SET status = ?,
          updated_at = ?
      WHERE conversation_key = ?
        AND thread_id = ?
    `);
    this.updateCodexThreadGoalStatusStatement = this.db.prepare(`
      UPDATE threads
      SET goal_status = ?,
          goal_updated_at = ?,
          updated_at = ?
      WHERE thread_id = ?
    `);
    this.selectCodexThreadWorkStats = this.db.prepare(`
      SELECT
        COUNT(*) AS turn_count,
        COALESCE(SUM(CASE
          WHEN terminal_at IS NOT NULL AND started_at IS NOT NULL AND terminal_at > started_at
          THEN terminal_at - started_at
          ELSE 0
        END), 0) AS total_work_duration_ms
      FROM (
        SELECT
          codex_turn_id,
          MIN(processing_started_at) AS started_at,
          MAX(COALESCE(completed_at, failed_at, cleared_at)) AS terminal_at
        FROM lark_messages
        WHERE thread_id = ?
          AND codex_turn_id IS NOT NULL
          AND processing_started_at IS NOT NULL
          AND route_kind <> 'side_message'
        GROUP BY codex_turn_id
      )
    `);
    this.selectCodexThreadStatusStats = this.db.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM lark_messages
          WHERE thread_id = @codexThreadId
            AND route_kind IN ('message', 'goal_message', 'steered_message', 'queued_message', 'side_message')
        ) AS user_message_count,
        COUNT(*) AS turn_count,
        COALESCE(SUM(CASE
          WHEN terminal_at IS NOT NULL AND started_at IS NOT NULL AND terminal_at > started_at
          THEN terminal_at - started_at
          ELSE 0
        END), 0) AS total_work_duration_ms
      FROM (
        SELECT
          codex_turn_id,
          MIN(processing_started_at) AS started_at,
          MAX(COALESCE(completed_at, failed_at, cleared_at)) AS terminal_at
        FROM lark_messages
        WHERE thread_id = @codexThreadId
          AND codex_turn_id IS NOT NULL
          AND processing_started_at IS NOT NULL
          AND route_kind <> 'side_message'
        GROUP BY codex_turn_id
      )
    `);
    this.selectConversationStatusStats = this.db.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM threads
          WHERE conversation_key = @conversationKey
        ) AS topic_count,
        (
          SELECT COUNT(*)
          FROM lark_messages
          WHERE conversation_key = @conversationKey
            AND route_kind IN ('message', 'goal_message', 'steered_message', 'queued_message', 'side_message')
        ) AS user_message_count,
        (
          SELECT COALESCE(SUM(input_tokens), 0)
          FROM threads
          WHERE conversation_key = @conversationKey
        ) AS input_tokens,
        (
          SELECT COALESCE(SUM(output_tokens), 0)
          FROM threads
          WHERE conversation_key = @conversationKey
        ) AS output_tokens,
        (
          SELECT COALESCE(SUM(cached_input_tokens), 0)
          FROM threads
          WHERE conversation_key = @conversationKey
        ) AS cached_input_tokens,
        (
          SELECT COALESCE(SUM(reasoning_output_tokens), 0)
          FROM threads
          WHERE conversation_key = @conversationKey
        ) AS reasoning_output_tokens,
        (
          SELECT COALESCE(SUM(total_tokens), 0)
          FROM threads
          WHERE conversation_key = @conversationKey
        ) AS total_tokens,
        COALESCE(SUM(CASE
          WHEN terminal_at IS NOT NULL AND started_at IS NOT NULL AND terminal_at > started_at
          THEN terminal_at - started_at
          ELSE 0
        END), 0) AS total_work_duration_ms
      FROM (
        SELECT
          thread_id,
          codex_turn_id,
          MIN(processing_started_at) AS started_at,
          MAX(COALESCE(completed_at, failed_at, cleared_at)) AS terminal_at
        FROM lark_messages
        WHERE conversation_key = @conversationKey
          AND thread_id IS NOT NULL
          AND codex_turn_id IS NOT NULL
          AND processing_started_at IS NOT NULL
          AND route_kind <> 'side_message'
        GROUP BY thread_id, codex_turn_id
      )
    `);
    this.insertLarkMessageStatement = this.db.prepare(`
      INSERT INTO lark_messages (
        lark_message_id,
        event_id,
        lark_user_id,
        lark_group_id,
        lark_thread_id,
        conversation_key,
        thread_id,
        codex_turn_id,
        route_kind,
        status,
        text,
        lark_create_time,
        side_id,
        agent_card_message_id,
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
        @sideId,
        @agentCardMessageId,
        @receivedAt,
        @updatedAt,
        @rawEventJson
      )
      ON CONFLICT(event_id) DO NOTHING
    `);
    this.selectLarkMessageById = this.db.prepare(`
      SELECT * FROM lark_messages WHERE lark_message_id = ?
    `);
    this.selectLarkMessageByEventId = this.db.prepare(`
      SELECT * FROM lark_messages
      WHERE event_id = ?
      ORDER BY id ASC
      LIMIT 1
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
          thread_id = COALESCE(?, thread_id),
          codex_turn_id = COALESCE(?, codex_turn_id),
          processing_started_at = COALESCE(processing_started_at, ?),
          updated_at = ?
      WHERE lark_message_id = ?
    `);
    this.updateLarkMessageQueuedStatement = this.db.prepare(`
      UPDATE lark_messages
      SET route_kind = 'queued_message',
          status = 'queued',
          thread_id = NULL,
          codex_turn_id = NULL,
          updated_at = ?
      WHERE lark_message_id = ?
    `);
    this.updateQueuedLarkMessageStatement = this.db.prepare(`
      UPDATE lark_messages
      SET text = ?,
          raw_event_json = COALESCE(?, raw_event_json),
          updated_at = ?
      WHERE lark_message_id = ?
        AND status = 'queued'
    `);
    this.updateLarkMessageSideMetadataStatement = this.db.prepare(`
      UPDATE lark_messages
      SET side_id = COALESCE(?, side_id),
          agent_card_message_id = COALESCE(?, agent_card_message_id),
          updated_at = ?
      WHERE lark_message_id = ?
    `);
    this.updateLarkMessageRecalledStatement = this.db.prepare(`
      UPDATE lark_messages
      SET status = 'recalled',
          updated_at = ?
      WHERE lark_message_id = ?
        AND status = 'queued'
    `);
    this.updateLarkMessageSteeredStatement = this.db.prepare(`
      UPDATE lark_messages
      SET status = 'steered',
          conversation_key = COALESCE(?, conversation_key),
          thread_id = COALESCE(?, thread_id),
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
    assertExpectedConversationKey(conversationKeyForTypeAndChatId(type, chatId), type, chatId);
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
      this.updateThread.run(
        update.codexThreadId,
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

  updateConversationSettings(conversationKey: string, update: UpdateConversationSettingsInput): ConversationRecord {
    assertValidConversationKey(conversationKey);
    if (update.type !== undefined) {
      assertValidConversationType(update.type);
    }
    if (update.name !== undefined) {
      assertNonEmpty(update.name, "name");
    }
    if (update.responseMode !== undefined) {
      assertValidResponseMode(update.responseMode);
    }

    const updateSettings = this.db.transaction(() => {
      const existing = this.requireByConversationKey(conversationKey);
      const type = update.type ?? existing.type;
      assertExpectedConversationKey(conversationKey, type, existing.chatId);
      const name = update.name ?? existing.name;
      const responseMode = update.responseMode ?? existing.responseMode;
      this.updateSettings.run(type, name, responseMode, this.now(), conversationKey);
      return this.requireByConversationKey(conversationKey);
    });

    return updateSettings();
  }

  markThreadHasRollout(conversationKey: string, codexThreadId: string): void {
    assertValidConversationKey(conversationKey);
    assertNonEmpty(codexThreadId, "codexThreadId");
    const now = this.now();
    this.markCodexThreadRollout.run(now, conversationKey, codexThreadId);
  }

  deleteByConversationKey(conversationKey: string): boolean {
    assertValidConversationKey(conversationKey);
    const remove = this.db.transaction(() => this.deleteByKey.run(conversationKey).changes > 0);
    return remove();
  }

  upsertCodexThread(input: UpsertCodexThreadInput): CodexThreadRecord {
    validateCodexThreadInput(input);
    const now = this.now();
    this.upsertCodexThreadStatement.run({
      codexThreadId: input.codexThreadId,
      conversationKey: input.conversationKey,
      name: input.name ?? null,
      larkThreadId: input.larkThreadId ?? null,
      role: input.role,
      forkedFromCodexThreadId: input.forkedFromCodexThreadId ?? null,
      forkedAt: input.forkedAt ?? null,
      codexThreadHasRollout: input.codexThreadHasRollout === true ? 1 : 0,
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

  getCodexThreadByConversationAndLarkThread(
    conversationKey: string,
    larkThreadId: string
  ): CodexThreadRecord | undefined {
    assertValidConversationKey(conversationKey);
    assertNonEmpty(larkThreadId, "larkThreadId");
    return mapCodexThreadRow(this.selectCodexThreadByConversationAndLarkThread.get(conversationKey, larkThreadId));
  }

  replaceCodexThreadForLarkThread(
    conversationKey: string,
    larkThreadId: string,
    update: { codexThreadId: string; role: RoleName; codexThreadHasRollout?: boolean }
  ): CodexThreadRecord {
    const input = {
      conversationKey,
      larkThreadId,
      codexThreadId: update.codexThreadId,
      role: update.role,
      codexThreadHasRollout: update.codexThreadHasRollout
    };
    validateReplaceCodexThreadForLarkThread(input);
    const now = this.now();
    const codexThreadHasRollout = input.codexThreadHasRollout === true ? 1 : 0;
    const replace = this.db.transaction(() => {
      const result = this.replaceCodexThreadForLarkThreadStatement.run({
        ...input,
        codexThreadHasRollout,
        updatedAt: now
      });
      if (result.changes === 0) {
        this.upsertCodexThreadStatement.run({
          codexThreadId: input.codexThreadId,
          conversationKey: input.conversationKey,
          name: null,
          larkThreadId: input.larkThreadId,
          role: input.role,
          forkedFromCodexThreadId: null,
          forkedAt: null,
          codexThreadHasRollout,
          totalTokens: 0,
          tokenUsageJson: "{}",
          createdAt: now,
          updatedAt: now
        });
      }
      return this.requireCodexThreadById(input.codexThreadId);
    });
    return replace();
  }

  updateCodexThreadTokenUsage(input: UpdateCodexThreadTokenUsageInput): CodexThreadRecord {
    assertNonEmpty(input.codexThreadId, "codexThreadId");
    assertValidConversationKey(input.conversationKey);
    assertValidRole(input.role);
    assertNonNegativeFinite(input.inputTokens, "inputTokens");
    assertNonNegativeFinite(input.outputTokens, "outputTokens");
    assertNonNegativeFinite(input.cachedInputTokens, "cachedInputTokens");
    assertNonNegativeFinite(input.reasoningOutputTokens, "reasoningOutputTokens");
    if (!Number.isFinite(input.totalTokens) || input.totalTokens < 0) {
      throw new TwinnyError("totalTokens must be a non-negative finite number", "CODEX_THREAD_TOKEN_USAGE_INVALID");
    }
    assertNonNegativeFinite(input.contextTokens, "contextTokens");
    assertNonNegativeFinite(input.contextWindow, "contextWindow");
    assertNonEmpty(input.tokenUsageJson, "tokenUsageJson");
    const now = this.now();
    this.updateCodexThreadUsageStatement.run({
      codexThreadId: input.codexThreadId,
      conversationKey: input.conversationKey,
      name: null,
      role: input.role,
      inputTokens: Math.trunc(input.inputTokens),
      outputTokens: Math.trunc(input.outputTokens),
      cachedInputTokens: Math.trunc(input.cachedInputTokens),
      reasoningOutputTokens: Math.trunc(input.reasoningOutputTokens),
      totalTokens: Math.trunc(input.totalTokens),
      contextTokens: Math.trunc(input.contextTokens),
      contextWindow: Math.trunc(input.contextWindow),
      tokenUsageJson: input.tokenUsageJson,
      createdAt: now,
      updatedAt: now
    });
    return this.requireCodexThreadById(input.codexThreadId);
  }

  updateCodexThreadCard(input: UpdateCodexThreadCardInput): CodexThreadRecord {
    assertNonEmpty(input.codexThreadId, "codexThreadId");
    assertValidConversationKey(input.conversationKey);
    assertValidRole(input.role);
    if (input.larkThreadId !== undefined) {
      assertNonEmpty(input.larkThreadId, "larkThreadId");
    }
    if (input.name !== undefined) {
      assertNonEmpty(input.name, "name");
    }
    if (input.creatorOpenId !== undefined) {
      assertNonEmpty(input.creatorOpenId, "creatorOpenId");
    }
    if (input.cardMessageId !== undefined) {
      assertNonEmpty(input.cardMessageId, "cardMessageId");
    }
    const now = this.now();
    this.updateCodexThreadCardStatement.run({
      codexThreadId: input.codexThreadId,
      conversationKey: input.conversationKey,
      name: input.name ?? null,
      role: input.role,
      larkThreadId: input.larkThreadId ?? null,
      creatorOpenId: input.creatorOpenId ?? null,
      cardMessageId: input.cardMessageId ?? null,
      createdAt: now,
      updatedAt: now
    });
    return this.requireCodexThreadById(input.codexThreadId);
  }

  updateCodexThreadName(codexThreadId: string, name: string): CodexThreadRecord | undefined {
    assertNonEmpty(codexThreadId, "codexThreadId");
    assertNonEmpty(name, "name");
    const result = this.updateCodexThreadNameStatement.run(name, this.now(), codexThreadId);
    if (result.changes === 0) {
      return undefined;
    }
    return this.requireCodexThreadById(codexThreadId);
  }

  updateCodexThreadMode(
    conversationKey: string,
    codexThreadId: string,
    mode: CodexThreadMode
  ): CodexThreadRecord {
    assertValidConversationKey(conversationKey);
    assertNonEmpty(codexThreadId, "codexThreadId");
    assertValidCodexThreadMode(mode);
    const result = this.updateCodexThreadModeStatement.run(mode, this.now(), conversationKey, codexThreadId);
    if (result.changes === 0) {
      throw new TwinnyError(`Codex thread ${codexThreadId} was not found`, "CODEX_THREAD_NOT_FOUND");
    }
    return this.requireCodexThreadById(codexThreadId);
  }

  updateCodexThreadStatus(
    conversationKey: string,
    codexThreadId: string,
    status: CodexThreadStatus
  ): CodexThreadRecord {
    assertValidConversationKey(conversationKey);
    assertNonEmpty(codexThreadId, "codexThreadId");
    assertValidCodexThreadStatus(status);
    const result = this.updateCodexThreadStatusStatement.run(status, this.now(), conversationKey, codexThreadId);
    if (result.changes === 0) {
      throw new TwinnyError(`Codex thread ${codexThreadId} was not found`, "CODEX_THREAD_NOT_FOUND");
    }
    return this.requireCodexThreadById(codexThreadId);
  }

  updateCodexThreadGoalStatus(input: UpdateCodexThreadGoalStatusInput): CodexThreadRecord {
    assertNonEmpty(input.codexThreadId, "codexThreadId");
    assertValidCodexThreadGoalStatus(input.goalStatus);
    const now = this.now();
    const goalUpdatedAt = input.goalStatus === "none" ? null : Math.trunc(input.goalUpdatedAt ?? now);
    const result = this.updateCodexThreadGoalStatusStatement.run(input.goalStatus, goalUpdatedAt, now, input.codexThreadId);
    if (result.changes === 0) {
      throw new TwinnyError(`Codex thread ${input.codexThreadId} was not found`, "CODEX_THREAD_NOT_FOUND");
    }
    return this.requireCodexThreadById(input.codexThreadId);
  }

  clearCodexThreadGoalStatus(codexThreadId: string): CodexThreadRecord {
    return this.updateCodexThreadGoalStatus({ codexThreadId, goalStatus: "none" });
  }

  getCodexThreadWorkStats(codexThreadId: string): CodexThreadWorkStats {
    assertNonEmpty(codexThreadId, "codexThreadId");
    const row = this.selectCodexThreadWorkStats.get(codexThreadId);
    return {
      turnCount: Math.trunc(row?.turn_count ?? 0),
      totalWorkDurationMs: Math.trunc(row?.total_work_duration_ms ?? 0)
    };
  }

  getCodexThreadStatusStats(codexThreadId: string): CodexThreadStatusStats {
    assertNonEmpty(codexThreadId, "codexThreadId");
    const row = this.selectCodexThreadStatusStats.get({ codexThreadId });
    return {
      userMessageCount: Math.trunc(row?.user_message_count ?? 0),
      turnCount: Math.trunc(row?.turn_count ?? 0),
      totalWorkDurationMs: Math.trunc(row?.total_work_duration_ms ?? 0)
    };
  }

  getConversationStatusStats(conversationKey: string): ConversationStatusStats {
    assertValidConversationKey(conversationKey);
    const row = this.selectConversationStatusStats.get({ conversationKey });
    return {
      topicCount: Math.trunc(row?.topic_count ?? 0),
      userMessageCount: Math.trunc(row?.user_message_count ?? 0),
      inputTokens: Math.trunc(row?.input_tokens ?? 0),
      outputTokens: Math.trunc(row?.output_tokens ?? 0),
      cachedInputTokens: Math.trunc(row?.cached_input_tokens ?? 0),
      reasoningOutputTokens: Math.trunc(row?.reasoning_output_tokens ?? 0),
      totalTokens: Math.trunc(row?.total_tokens ?? 0),
      totalWorkDurationMs: Math.trunc(row?.total_work_duration_ms ?? 0)
    };
  }

  insertLarkMessage(input: InsertLarkMessageInput): LarkMessageRecord {
    validateLarkMessageInput(input);
    const now = this.now();
    this.insertLarkMessageStatement.run({
      larkMessageId: input.larkMessageId ?? null,
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
      sideId: input.sideId ?? null,
      agentCardMessageId: input.agentCardMessageId ?? null,
      receivedAt: now,
      updatedAt: now,
      rawEventJson: input.rawEventJson ?? null
    });
    return this.requireLarkMessageByEventId(input.eventId);
  }

  getLarkMessageById(larkMessageId: string): LarkMessageRecord | undefined {
    assertNonEmpty(larkMessageId, "larkMessageId");
    return mapLarkMessageRow(this.selectLarkMessageById.get(larkMessageId));
  }

  getLarkMessageByEventId(eventId: string): LarkMessageRecord | undefined {
    assertNonEmpty(eventId, "eventId");
    return mapLarkMessageRow(this.selectLarkMessageByEventId.get(eventId));
  }

  listUnfinishedLarkMessages(): LarkMessageRecord[] {
    return this.selectUnfinishedLarkMessages.all().map((row) => mapRequiredLarkMessageRow(row));
  }

  markLarkMessageQueued(larkMessageId: string): void {
    assertNonEmpty(larkMessageId, "larkMessageId");
    this.updateLarkMessageQueuedStatement.run(this.now(), larkMessageId);
  }

  updateQueuedLarkMessage(larkMessageId: string, update: { text: string; rawEventJson?: string }): boolean {
    assertNonEmpty(larkMessageId, "larkMessageId");
    const result = this.updateQueuedLarkMessageStatement.run(
      update.text,
      update.rawEventJson ?? null,
      this.now(),
      larkMessageId
    );
    return result.changes > 0;
  }

  updateLarkMessageSideMetadata(
    larkMessageId: string,
    update: { sideId?: number; agentCardMessageId?: string }
  ): boolean {
    assertNonEmpty(larkMessageId, "larkMessageId");
    const result = this.updateLarkMessageSideMetadataStatement.run(
      update.sideId ?? null,
      update.agentCardMessageId ?? null,
      this.now(),
      larkMessageId
    );
    return result.changes > 0;
  }

  markLarkMessageRecalled(larkMessageId: string): boolean {
    assertNonEmpty(larkMessageId, "larkMessageId");
    const result = this.updateLarkMessageRecalledStatement.run(this.now(), larkMessageId);
    return result.changes > 0;
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
      responseMode: input.responseMode ?? (input.type === "p2p" ? "all" : "none"),
      role: input.role,
      codexThreadId: input.codexThreadId,
      workspace: input.workspace,
      roleCodexHome: input.roleCodexHome,
      createdAt: now,
      updatedAt: now
    };
  }

  private requireCodexThreadById(codexThreadId: string): CodexThreadRecord {
    const record = this.getCodexThreadById(codexThreadId);
    if (!record) {
      throw new TwinnyError(`Codex thread ${codexThreadId} was not found`, "CODEX_THREAD_NOT_FOUND");
    }
    return record;
  }

  private requireLarkMessageByEventId(eventId: string): LarkMessageRecord {
    const record = this.getLarkMessageByEventId(eventId);
    if (!record) {
      throw new TwinnyError(`Lark event ${eventId} was not found`, "LARK_MESSAGE_NOT_FOUND");
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
    responseMode: row.response_mode,
    role: row.role,
    codexThreadId: row.thread_id,
    workspace: row.workspace,
    roleCodexHome: row.role_codex_home,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCodexThreadRow(row: CodexThreadRow | undefined): CodexThreadRecord | undefined {
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    codexThreadId: row.thread_id,
    conversationKey: row.conversation_key,
    name: row.name,
    larkThreadId: row.lark_thread_id ?? undefined,
    role: row.role,
    mode: validCodexThreadMode(row.mode) ? row.mode : "default",
    status: validCodexThreadStatus(row.status) ? row.status : "idle",
    goalStatus: validCodexThreadGoalStatus(row.goal_status) ? row.goal_status : "none",
    goalUpdatedAt: row.goal_updated_at ?? undefined,
    forkedFromCodexThreadId: row.forked_from_thread_id ?? undefined,
    forkedAt: row.forked_at ?? undefined,
    creatorOpenId: row.creator_open_id ?? undefined,
    cardMessageId: row.card_message_id ?? undefined,
    codexThreadHasRollout: row.thread_has_rollout === 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    totalTokens: row.total_tokens,
    contextTokens: row.context_tokens,
    contextWindow: row.context_window,
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
    larkMessageId: row.lark_message_id ?? undefined,
    eventId: row.event_id,
    larkUserId: row.lark_user_id,
    larkGroupId: row.lark_group_id ?? undefined,
    larkThreadId: row.lark_thread_id ?? undefined,
    conversationKey: row.conversation_key ?? undefined,
    codexThreadId: row.thread_id ?? undefined,
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
    sideId: row.side_id ?? undefined,
    agentCardMessageId: row.agent_card_message_id ?? undefined,
    rawEventJson: row.raw_event_json ?? undefined
  };
}

function validateNewConversation(input: NewConversationRecord): void {
  assertExpectedConversationKey(input.conversationKey, input.type, input.chatId);
  assertNonEmpty(input.name, "name");
  if (input.responseMode !== undefined) {
    assertValidResponseMode(input.responseMode);
  }
  assertValidRole(input.role);
  assertNonEmpty(input.codexThreadId, "codexThreadId");
  assertAbsolutePath(input.workspace, "workspace");
  assertNonEmpty(input.roleCodexHome, "roleCodexHome");
}

function validateCodexThreadInput(input: UpsertCodexThreadInput): void {
  assertNonEmpty(input.codexThreadId, "codexThreadId");
  assertValidConversationKey(input.conversationKey);
  assertValidRole(input.role);
  if (input.name !== undefined) {
    assertNonEmpty(input.name, "name");
  }
  if (input.larkThreadId !== undefined) {
    assertNonEmpty(input.larkThreadId, "larkThreadId");
  }
  if (input.forkedFromCodexThreadId !== undefined) {
    assertNonEmpty(input.forkedFromCodexThreadId, "forkedFromCodexThreadId");
  }
}

function validateReplaceCodexThreadForLarkThread(input: ReplaceCodexThreadForLarkThreadInput): void {
  assertValidConversationKey(input.conversationKey);
  assertNonEmpty(input.larkThreadId, "larkThreadId");
  assertNonEmpty(input.codexThreadId, "codexThreadId");
  assertValidRole(input.role);
}

function validateLarkMessageInput(input: InsertLarkMessageInput): void {
  if (input.routeKind === "card_action" || input.routeKind === "menu_action") {
    if (input.larkMessageId !== undefined) {
      assertNonEmpty(input.larkMessageId, "larkMessageId");
    }
  } else {
    if (input.larkMessageId === undefined) {
      throw new TwinnyError("larkMessageId is required", "CONVERSATION_FIELD_EMPTY");
    }
    assertNonEmpty(input.larkMessageId, "larkMessageId");
  }
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

function assertExpectedConversationKey(conversationKey: string, type: ConversationType, chatId: string): void {
  assertValidConversationType(type);
  const expectedKey = conversationKeyForTypeAndChatId(type, chatId);
  if (conversationKey !== expectedKey) {
    throw new TwinnyError(
      `Conversation key for ${type} must be ${expectedKey}, received ${conversationKey}`,
      "CONVERSATION_KEY_MISMATCH"
    );
  }
}

function conversationKeyForTypeAndChatId(type: ConversationType, chatId: string): string {
  if (type === "p2p") {
    return createP2PConversationKey(chatId);
  }
  return createGroupConversationKey(chatId);
}

function assertValidConversationType(type: ConversationType): void {
  if (type !== "p2p" && type !== "group" && type !== "topic_group") {
    throw new TwinnyError(`Unsupported conversation type: ${type}`, "CONVERSATION_TYPE_INVALID");
  }
}

function assertValidResponseMode(responseMode: ConversationResponseMode): void {
  if (responseMode !== "all" && responseMode !== "at" && responseMode !== "none") {
    throw new TwinnyError(`Unsupported conversation response mode: ${responseMode}`, "CONVERSATION_RESPONSE_MODE_INVALID");
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
    routeKind !== "side_message" &&
    routeKind !== "goal_message" &&
    routeKind !== "control_message" &&
    routeKind !== "card_action" &&
    routeKind !== "menu_action"
  ) {
    throw new TwinnyError(`Unsupported Lark message route kind: ${routeKind}`, "LARK_MESSAGE_ROUTE_KIND_INVALID");
  }
}

function assertValidMessageStatus(status: LarkMessageStatus): void {
  if (
    status !== "queued" &&
    status !== "recalled" &&
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

function assertValidCodexThreadStatus(status: CodexThreadStatus): void {
  if (!validCodexThreadStatus(status)) {
    throw new TwinnyError(`Unsupported Codex thread status: ${status}`, "CODEX_THREAD_STATUS_INVALID");
  }
}

function assertValidCodexThreadGoalStatus(status: CodexThreadGoalStatus): void {
  if (!validCodexThreadGoalStatus(status)) {
    throw new TwinnyError(`Unsupported Codex thread goal status: ${status}`, "CODEX_THREAD_GOAL_STATUS_INVALID");
  }
}

function assertValidCodexThreadMode(mode: CodexThreadMode): void {
  if (!validCodexThreadMode(mode)) {
    throw new TwinnyError(`Unsupported Codex thread mode: ${mode}`, "CODEX_THREAD_MODE_INVALID");
  }
}

function validCodexThreadMode(mode: unknown): mode is CodexThreadMode {
  return mode === "default" || mode === "plan";
}

function validCodexThreadStatus(status: unknown): status is CodexThreadStatus {
  return status === "idle" || status === "working" || status === "waiting";
}

function validCodexThreadGoalStatus(status: unknown): status is CodexThreadGoalStatus {
  return (
    status === "none" ||
    status === "active" ||
    status === "paused" ||
    status === "blocked" ||
    status === "usageLimited" ||
    status === "budgetLimited" ||
    status === "complete"
  );
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

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TwinnyError(`${field} must be a non-negative finite number`, "CODEX_THREAD_TOKEN_USAGE_INVALID");
  }
}
