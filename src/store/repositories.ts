import path from "node:path";

import { TwinnyError } from "../errors.js";
import type {
  CodexThreadRecord,
  CodexThreadGoalStatus,
  CodexThreadMode,
  CodexThreadStatus,
  ConversationResponseMode,
  ConversationRecord,
  ConversationType,
  LarkDocWatcherRecord,
  LarkDocWatchMode,
  LarkMessageRecord,
  LarkMessageRouteKind,
  LarkMessageStatus,
  NewConversationRecord,
  ProfileName
} from "../types.js";
import { assertValidConversationKey, createGroupConversationKey, createP2PConversationKey } from "../workspace/slug.js";
import type { TwinnyDatabase, TwinnyStatement } from "./db.js";

interface ConversationRow {
  id: number;
  conversation_key: string;
  type: ConversationType;
  chat_id: string;
  name: string;
  response_mode: ConversationResponseMode;
  profile: ProfileName;
  thread_id: string;
  workspace: string;
  profile_codex_home: string;
  created_at: number;
  updated_at: number;
}

interface InsertConversationParams {
  conversationKey: string;
  type: ConversationType;
  chatId: string;
  name: string;
  responseMode: ConversationResponseMode;
  profile: ProfileName;
  codexThreadId: string;
  workspace: string;
  profileCodexHome: string;
  createdAt: number;
  updatedAt: number;
}

interface CodexThreadRow {
  id: number;
  thread_id: string;
  conversation_key: string;
  workspace: string;
  name: string;
  lark_thread_id: string | null;
  profile: ProfileName;
  model: string | null;
  effort: string | null;
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
  doc_comment_id: string | null;
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
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
  token_usage_json: string;
}

interface LarkDocWatcherRow {
  id: number;
  file_type: string;
  file_token: string;
  thread_id: string;
  watch_mode: LarkDocWatchMode;
  watch_url: string;
  last_comment_received_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface UpsertCodexThreadInput {
  codexThreadId: string;
  conversationKey: string;
  workspace?: string;
  profile: ProfileName;
  name?: string;
  model?: string;
  effort?: string;
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
  docCommentId?: string;
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
  workspace?: string;
  profile: ProfileName;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  contextTokens: number;
  contextWindow: number;
  tokenUsageJson: string;
}

export interface UpdateLarkMessageTokenUsageInput {
  larkMessageId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
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
  workspace?: string;
  profile: ProfileName;
  model?: string;
  effort?: string;
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
  workspace?: string;
  profile: ProfileName;
  model?: string;
  effort?: string;
  codexThreadHasRollout?: boolean;
}

export interface UpdateCodexThreadModelSettingsInput {
  codexThreadId: string;
  model: string;
  effort: string;
}

export interface UpdateConversationThreadBinding {
  codexThreadId: string;
  profile?: ProfileName;
  profileCodexHome?: string;
  workspace?: string;
}

export interface UpdateConversationSettingsInput {
  type?: ConversationType;
  name?: string;
  responseMode?: ConversationResponseMode;
}

export interface UpsertLarkDocWatcherInput {
  fileType: string;
  fileToken: string;
  threadId: string;
  watchMode: LarkDocWatchMode;
  watchUrl: string;
}

export interface ConversationRepositoryOptions {
  now?: () => number;
}

export class ConversationRepository {
  private readonly now: () => number;

  private readonly insertConversation: TwinnyStatement<[InsertConversationParams]>;
  private readonly selectByConversationKey: TwinnyStatement<[string], ConversationRow>;
  private readonly selectByTypeAndChatId: TwinnyStatement<[ConversationType, string], ConversationRow>;
  private readonly selectByCodexThreadId: TwinnyStatement<[string], ConversationRow>;
  private readonly selectAll: TwinnyStatement<[], ConversationRow>;
  private readonly updateSettings: TwinnyStatement<[ConversationType, string, string, number, string]>;
  private readonly updateConversationWorkspaceStatement: TwinnyStatement<[string, number, string]>;
  private readonly updateThread: TwinnyStatement<[
    string,
    ProfileName,
    string,
    string,
    number,
    string
  ]>;
  private readonly markCodexThreadRollout: TwinnyStatement<[number, string, string]>;
  private readonly deleteByKey: TwinnyStatement<[string]>;
  private readonly upsertCodexThreadStatement: TwinnyStatement<[Record<string, unknown>]>;
  private readonly selectCodexThreadById: TwinnyStatement<[string], CodexThreadRow>;
  private readonly selectCodexThreadByConversationAndLarkThread: TwinnyStatement<[string, string], CodexThreadRow>;
  private readonly replaceCodexThreadForLarkThreadStatement: TwinnyStatement<[Record<string, unknown>]>;
  private readonly updateCodexThreadUsageStatement: TwinnyStatement<[Record<string, unknown>]>;
  private readonly updateCodexThreadCardStatement: TwinnyStatement<[Record<string, unknown>]>;
  private readonly updateCodexThreadModelSettingsStatement: TwinnyStatement<[string, string, number, string]>;
  private readonly updateCodexThreadWorkspaceStatement: TwinnyStatement<[string, number, string]>;
  private readonly updateCodexThreadNameStatement: TwinnyStatement<[string, number, string]>;
  private readonly updateCodexThreadModeStatement: TwinnyStatement<[CodexThreadMode, number, string, string]>;
  private readonly updateCodexThreadStatusStatement: TwinnyStatement<[CodexThreadStatus, number, string, string]>;
  private readonly updateCodexThreadGoalStatusStatement: TwinnyStatement<[CodexThreadGoalStatus, number | null, number, string]>;
  private readonly selectCodexThreadWorkStats: TwinnyStatement<[string], CodexThreadWorkStatsRow>;
  private readonly selectCodexThreadStatusStats: TwinnyStatement<[Record<string, unknown>], CodexThreadStatusStatsRow>;
  private readonly selectConversationStatusStats: TwinnyStatement<[Record<string, unknown>], ConversationStatusStatsRow>;
  private readonly selectRecentThreadWorkspacesStatement: TwinnyStatement<[number, number], { workspace: string }>;
  private readonly insertLarkMessageStatement: TwinnyStatement<[Record<string, unknown>]>;
  private readonly selectLarkMessageById: TwinnyStatement<[string], LarkMessageRow>;
  private readonly selectLarkMessageByEventId: TwinnyStatement<[string], LarkMessageRow>;
  private readonly selectProcessedDocCommentCount: TwinnyStatement<[string], { count: number }>;
  private readonly selectLarkMessageUsageTargetForTurn: TwinnyStatement<[string, string], LarkMessageRow>;
  private readonly selectLatestSteeredLarkMessageForTurn: TwinnyStatement<[string, string], LarkMessageRow>;
  private readonly selectContiguousSteeredLarkMessagesBefore: TwinnyStatement<[Record<string, unknown>], LarkMessageRow>;
  private readonly selectUnfinishedLarkMessages: TwinnyStatement<[], LarkMessageRow>;
  private readonly updateLarkMessageUsageStatement: TwinnyStatement<[Record<string, unknown>]>;
  private readonly updateLarkMessageProcessingStatement: TwinnyStatement<[
    string | null,
    string | null,
    string | null,
    number,
    number,
    string
  ]>;
  private readonly updateLarkMessageSteeredStatement: TwinnyStatement<[
    string | null,
    string | null,
    string | null,
    number,
    string
  ]>;
  private readonly updateLarkMessageQueuedStatement: TwinnyStatement<[number, string]>;
  private readonly updateQueuedLarkMessageStatement: TwinnyStatement<[string, string | null, number, string]>;
  private readonly updateLarkMessageSideMetadataStatement: TwinnyStatement<[number | null, string | null, number, string]>;
  private readonly updateLarkMessageRecalledStatement: TwinnyStatement<[number, string]>;
  private readonly updateLarkMessageCompletedStatement: TwinnyStatement<[number, number, string]>;
  private readonly updateLarkMessageFailedStatement: TwinnyStatement<[number, number, string]>;
  private readonly updateLarkMessageInterruptedStatement: TwinnyStatement<[number, number, string]>;
  private readonly updateLarkMessageClearedStatement: TwinnyStatement<[number, number, string]>;
  private readonly upsertLarkDocWatcherStatement: TwinnyStatement<[Record<string, unknown>]>;
  private readonly selectLarkDocWatcherByFileStatement: TwinnyStatement<[string, string], LarkDocWatcherRow>;
  private readonly selectLarkDocWatchersByThreadStatement: TwinnyStatement<[string], LarkDocWatcherRow>;
  private readonly migrateLarkDocWatchersToThreadStatement: TwinnyStatement<[string, number, string, string]>;
  private readonly updateLarkDocWatcherLastCommentStatement: TwinnyStatement<[number, number, string, string]>;

  constructor(
    private readonly db: TwinnyDatabase,
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
        profile,
        thread_id,
        workspace,
        profile_codex_home,
        created_at,
        updated_at
      ) VALUES (
        @conversationKey,
        @type,
        @chatId,
        @name,
        @responseMode,
        @profile,
        @codexThreadId,
        @workspace,
        @profileCodexHome,
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
    this.updateConversationWorkspaceStatement = this.db.prepare(`
      UPDATE conversations
      SET workspace = ?,
          updated_at = ?
      WHERE conversation_key = ?
    `);
    this.updateThread = this.db.prepare(`
      UPDATE conversations
      SET thread_id = ?,
          profile = ?,
          profile_codex_home = ?,
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
        workspace,
        name,
        lark_thread_id,
        profile,
        model,
        effort,
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
        COALESCE(@workspace, (SELECT workspace FROM conversations WHERE conversation_key = @conversationKey), ''),
        COALESCE(@name, '新会话'),
        @larkThreadId,
        @profile,
        @model,
        @effort,
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
        workspace = COALESCE(@workspace, threads.workspace),
        name = COALESCE(@name, threads.name),
        lark_thread_id = COALESCE(excluded.lark_thread_id, threads.lark_thread_id),
        profile = excluded.profile,
        model = COALESCE(excluded.model, threads.model),
        effort = COALESCE(excluded.effort, threads.effort),
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
          profile = @profile,
          model = @model,
          effort = @effort,
          workspace = COALESCE(@workspace, workspace),
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
        workspace,
        name,
        lark_thread_id,
        profile,
        model,
        effort,
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
        COALESCE(@workspace, (SELECT workspace FROM conversations WHERE conversation_key = @conversationKey), ''),
        COALESCE(@name, '新会话'),
        NULL,
        @profile,
        @model,
        @effort,
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
        workspace = COALESCE(@workspace, threads.workspace),
        name = COALESCE(@name, threads.name),
        profile = excluded.profile,
        model = COALESCE(excluded.model, threads.model),
        effort = COALESCE(excluded.effort, threads.effort),
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
        workspace,
        name,
        lark_thread_id,
        profile,
        model,
        effort,
        creator_open_id,
        card_message_id,
        thread_has_rollout,
        created_at,
        updated_at
      ) VALUES (
        @codexThreadId,
        @conversationKey,
        COALESCE(@workspace, (SELECT workspace FROM conversations WHERE conversation_key = @conversationKey), ''),
        COALESCE(@name, '新会话'),
        @larkThreadId,
        @profile,
        @model,
        @effort,
        @creatorOpenId,
        @cardMessageId,
        0,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        conversation_key = excluded.conversation_key,
        workspace = COALESCE(@workspace, threads.workspace),
        name = COALESCE(@name, threads.name),
        lark_thread_id = COALESCE(excluded.lark_thread_id, threads.lark_thread_id),
        profile = excluded.profile,
        model = COALESCE(excluded.model, threads.model),
        effort = COALESCE(excluded.effort, threads.effort),
        creator_open_id = COALESCE(excluded.creator_open_id, threads.creator_open_id),
        card_message_id = COALESCE(excluded.card_message_id, threads.card_message_id),
        updated_at = excluded.updated_at
    `);
    this.updateCodexThreadModelSettingsStatement = this.db.prepare(`
      UPDATE threads
      SET model = ?,
          effort = ?,
          updated_at = ?
      WHERE thread_id = ?
    `);
    this.updateCodexThreadWorkspaceStatement = this.db.prepare(`
      UPDATE threads
      SET workspace = ?,
          updated_at = ?
      WHERE thread_id = ?
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
            AND route_kind IN ('message', 'goal_message', 'steered_message', 'queued_message', 'side_message', 'doc_comment', 'doc_comment_reply_steer')
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
            AND route_kind IN ('message', 'goal_message', 'steered_message', 'queued_message', 'side_message', 'doc_comment', 'doc_comment_reply_steer')
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
    this.selectRecentThreadWorkspacesStatement = this.db.prepare(`
      SELECT workspace
      FROM (
        SELECT workspace, MAX(updated_at) AS latest_updated_at
        FROM threads
        WHERE updated_at >= ?
          AND workspace <> ''
        GROUP BY workspace
      )
      ORDER BY latest_updated_at DESC
      LIMIT ?
    `);
    this.insertLarkMessageStatement = this.db.prepare(`
      INSERT INTO lark_messages (
        lark_message_id,
        event_id,
        lark_user_id,
        lark_group_id,
        lark_thread_id,
        doc_comment_id,
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
        @docCommentId,
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
    this.selectProcessedDocCommentCount = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM lark_messages
      WHERE route_kind IN ('doc_comment', 'doc_comment_reply_steer')
        AND doc_comment_id = ?
    `);
    this.selectLarkMessageUsageTargetForTurn = this.db.prepare(`
      SELECT * FROM lark_messages
      WHERE thread_id = ?
        AND codex_turn_id = ?
        AND lark_message_id IS NOT NULL
        AND route_kind NOT IN ('steered_message', 'doc_comment_reply_steer')
      ORDER BY received_at ASC, id ASC
      LIMIT 1
    `);
    this.selectLatestSteeredLarkMessageForTurn = this.db.prepare(`
      SELECT * FROM lark_messages
      WHERE thread_id = ?
        AND codex_turn_id = ?
        AND lark_message_id IS NOT NULL
        AND route_kind = 'steered_message'
      ORDER BY received_at DESC, id DESC
      LIMIT 1
    `);
    this.selectContiguousSteeredLarkMessagesBefore = this.db.prepare(`
      SELECT candidate.*
      FROM lark_messages AS candidate
      WHERE candidate.conversation_key = @conversationKey
        AND candidate.thread_id = @threadId
        AND (
          (@codexTurnId IS NULL AND candidate.codex_turn_id IS NULL)
          OR candidate.codex_turn_id = @codexTurnId
        )
        AND candidate.status = 'steered'
        AND (
          candidate.received_at < @beforeReceivedAt
          OR (candidate.received_at = @beforeReceivedAt AND candidate.id < @beforeId)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM lark_messages AS boundary
          WHERE boundary.conversation_key = @conversationKey
            AND boundary.thread_id = @threadId
            AND (
              (@codexTurnId IS NULL AND boundary.codex_turn_id IS NULL)
              OR boundary.codex_turn_id = @codexTurnId
            )
            AND (
              boundary.received_at < @beforeReceivedAt
              OR (boundary.received_at = @beforeReceivedAt AND boundary.id < @beforeId)
            )
            AND (
              boundary.received_at > candidate.received_at
              OR (boundary.received_at = candidate.received_at AND boundary.id > candidate.id)
            )
            AND boundary.status <> 'steered'
        )
      ORDER BY candidate.received_at ASC, candidate.id ASC
    `);
    this.selectUnfinishedLarkMessages = this.db.prepare(`
      SELECT * FROM lark_messages
      WHERE status IN ('processing', 'queued')
      ORDER BY received_at ASC, id ASC
    `);
    this.updateLarkMessageUsageStatement = this.db.prepare(`
      UPDATE lark_messages
      SET input_tokens = @inputTokens,
          output_tokens = @outputTokens,
          cached_input_tokens = @cachedInputTokens,
          reasoning_output_tokens = @reasoningOutputTokens,
          token_usage_json = @tokenUsageJson,
          updated_at = @updatedAt
      WHERE lark_message_id = @larkMessageId
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
    this.upsertLarkDocWatcherStatement = this.db.prepare(`
      INSERT INTO lark_doc_watcher (
        file_type,
        file_token,
        thread_id,
        watch_mode,
        watch_url,
        created_at,
        updated_at
      ) VALUES (
        @fileType,
        @fileToken,
        @threadId,
        @watchMode,
        @watchUrl,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(file_type, file_token) DO UPDATE SET
        thread_id = excluded.thread_id,
        watch_mode = excluded.watch_mode,
        watch_url = excluded.watch_url,
        updated_at = excluded.updated_at
    `);
    this.selectLarkDocWatcherByFileStatement = this.db.prepare(`
      SELECT * FROM lark_doc_watcher
      WHERE file_type = ?
        AND file_token = ?
    `);
    this.selectLarkDocWatchersByThreadStatement = this.db.prepare(`
      SELECT * FROM lark_doc_watcher
      WHERE thread_id = ?
      ORDER BY updated_at DESC, id DESC
    `);
    this.migrateLarkDocWatchersToThreadStatement = this.db.prepare(`
      UPDATE lark_doc_watcher
      SET thread_id = ?,
          updated_at = ?
      WHERE thread_id = ?
        AND thread_id != ?
    `);
    this.updateLarkDocWatcherLastCommentStatement = this.db.prepare(`
      UPDATE lark_doc_watcher
      SET last_comment_received_at = ?,
          updated_at = ?
      WHERE file_type = ?
        AND file_token = ?
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
    const updateProfile = resolveOptionalInputProfile(update);
    if (updateProfile !== undefined) {
      assertValidProfile(updateProfile);
    }
    const updateProfileCodexHome = update.profileCodexHome;
    if (updateProfileCodexHome !== undefined) {
      assertNonEmpty(updateProfileCodexHome, "profileCodexHome");
    }
    if (update.workspace !== undefined) {
      assertAbsolutePath(update.workspace, "workspace");
    }

    const updateBinding = this.db.transaction(() => {
      const existing = this.requireByConversationKey(conversationKey);
      const profile = updateProfile ?? existing.profile;
      const profileCodexHome = updateProfileCodexHome ?? existing.profileCodexHome;
      const workspace = update.workspace ?? existing.workspace;
      const now = this.now();
      this.updateThread.run(
        update.codexThreadId,
        profile,
        profileCodexHome,
        workspace,
        now,
        conversationKey
      );
      this.updateCodexThreadWorkspaceStatement.run(workspace, now, update.codexThreadId);
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

  updateConversationWorkspace(conversationKey: string, workspace: string): ConversationRecord {
    assertValidConversationKey(conversationKey);
    assertAbsolutePath(workspace, "workspace");
    const updateWorkspace = this.db.transaction(() => {
      const existing = this.requireByConversationKey(conversationKey);
      const now = this.now();
      this.updateConversationWorkspaceStatement.run(workspace, now, conversationKey);
      this.updateCodexThreadWorkspaceStatement.run(workspace, now, existing.codexThreadId);
      return this.requireByConversationKey(conversationKey);
    });
    return updateWorkspace();
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
    const profile = resolveRequiredInputProfile(input);
    this.upsertCodexThreadStatement.run({
      codexThreadId: input.codexThreadId,
      conversationKey: input.conversationKey,
      workspace: input.workspace ?? null,
      name: input.name ?? null,
      larkThreadId: input.larkThreadId ?? null,
      profile,
      model: input.model ?? null,
      effort: input.effort ?? null,
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
    update: { codexThreadId: string; profile: ProfileName; workspace?: string; model?: string; effort?: string; codexThreadHasRollout?: boolean }
  ): CodexThreadRecord {
    const input = {
      conversationKey,
      larkThreadId,
      codexThreadId: update.codexThreadId,
      workspace: update.workspace,
      profile: update.profile,
      model: update.model,
      effort: update.effort,
      codexThreadHasRollout: update.codexThreadHasRollout
    };
    validateReplaceCodexThreadForLarkThread(input);
    const profile = resolveRequiredInputProfile(input);
    const now = this.now();
    const codexThreadHasRollout = input.codexThreadHasRollout === true ? 1 : 0;
    const replace = this.db.transaction(() => {
      const result = this.replaceCodexThreadForLarkThreadStatement.run({
        ...input,
        profile,
        codexThreadHasRollout,
        updatedAt: now
      });
      if (result.changes === 0) {
        this.upsertCodexThreadStatement.run({
          codexThreadId: input.codexThreadId,
          conversationKey: input.conversationKey,
          workspace: input.workspace ?? null,
          name: null,
          larkThreadId: input.larkThreadId,
          profile,
          model: input.model ?? null,
          effort: input.effort ?? null,
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
    if (input.workspace !== undefined) {
      assertAbsolutePath(input.workspace, "workspace");
    }
    const profile = resolveRequiredInputProfile(input);
    assertValidProfile(profile);
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
      workspace: input.workspace ?? null,
      name: null,
      profile,
      model: null,
      effort: null,
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
    if (input.workspace !== undefined) {
      assertAbsolutePath(input.workspace, "workspace");
    }
    const profile = resolveRequiredInputProfile(input);
    assertValidProfile(profile);
    if (input.model !== undefined) {
      assertNonEmpty(input.model, "model");
    }
    if (input.effort !== undefined) {
      assertNonEmpty(input.effort, "effort");
    }
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
      workspace: input.workspace ?? null,
      name: input.name ?? null,
      profile,
      model: input.model ?? null,
      effort: input.effort ?? null,
      larkThreadId: input.larkThreadId ?? null,
      creatorOpenId: input.creatorOpenId ?? null,
      cardMessageId: input.cardMessageId ?? null,
      createdAt: now,
      updatedAt: now
    });
    return this.requireCodexThreadById(input.codexThreadId);
  }

  updateCodexThreadModelSettings(input: UpdateCodexThreadModelSettingsInput): CodexThreadRecord {
    assertNonEmpty(input.codexThreadId, "codexThreadId");
    assertNonEmpty(input.model, "model");
    assertNonEmpty(input.effort, "effort");
    const result = this.updateCodexThreadModelSettingsStatement.run(
      input.model,
      input.effort,
      this.now(),
      input.codexThreadId
    );
    if (result.changes === 0) {
      throw new TwinnyError(`Codex thread ${input.codexThreadId} was not found`, "CODEX_THREAD_NOT_FOUND");
    }
    return this.requireCodexThreadById(input.codexThreadId);
  }

  updateCodexThreadWorkspace(codexThreadId: string, workspace: string): CodexThreadRecord {
    assertNonEmpty(codexThreadId, "codexThreadId");
    assertAbsolutePath(workspace, "workspace");
    const result = this.updateCodexThreadWorkspaceStatement.run(workspace, this.now(), codexThreadId);
    if (result.changes === 0) {
      throw new TwinnyError(`Codex thread ${codexThreadId} was not found`, "CODEX_THREAD_NOT_FOUND");
    }
    return this.requireCodexThreadById(codexThreadId);
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

  listRecentThreadWorkspaces(since: number, limit = 10): string[] {
    assertNonNegativeFinite(since, "since");
    assertPositiveInteger(limit, "limit");
    return this.selectRecentThreadWorkspacesStatement.all(Math.trunc(since), Math.trunc(limit)).map((row) => row.workspace);
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
      docCommentId: input.docCommentId ?? null,
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

  hasProcessedDocComment(commentId: string): boolean {
    assertNonEmpty(commentId, "commentId");
    return (this.selectProcessedDocCommentCount.get(commentId)?.count ?? 0) > 0;
  }

  getLarkMessageUsageTargetForTurn(codexThreadId: string, codexTurnId: string): LarkMessageRecord | undefined {
    assertNonEmpty(codexThreadId, "codexThreadId");
    assertNonEmpty(codexTurnId, "codexTurnId");
    return mapLarkMessageRow(this.selectLarkMessageUsageTargetForTurn.get(codexThreadId, codexTurnId));
  }

  getLatestSteeredLarkMessageForTurn(codexThreadId: string, codexTurnId: string): LarkMessageRecord | undefined {
    assertNonEmpty(codexThreadId, "codexThreadId");
    assertNonEmpty(codexTurnId, "codexTurnId");
    return mapLarkMessageRow(this.selectLatestSteeredLarkMessageForTurn.get(codexThreadId, codexTurnId));
  }

  listContiguousSteeredLarkMessagesBefore(record: LarkMessageRecord): LarkMessageRecord[] {
    if (!record.conversationKey || !record.codexThreadId) {
      return [];
    }
    return this.selectContiguousSteeredLarkMessagesBefore.all({
      conversationKey: record.conversationKey,
      threadId: record.codexThreadId,
      codexTurnId: record.codexTurnId ?? null,
      beforeReceivedAt: record.receivedAt,
      beforeId: record.id
    }).map((row) => mapRequiredLarkMessageRow(row));
  }

  listUnfinishedLarkMessages(): LarkMessageRecord[] {
    return this.selectUnfinishedLarkMessages.all().map((row) => mapRequiredLarkMessageRow(row));
  }

  updateLarkMessageTokenUsage(input: UpdateLarkMessageTokenUsageInput): LarkMessageRecord | undefined {
    assertNonEmpty(input.larkMessageId, "larkMessageId");
    assertNonNegativeFinite(input.inputTokens, "inputTokens");
    assertNonNegativeFinite(input.outputTokens, "outputTokens");
    assertNonNegativeFinite(input.cachedInputTokens, "cachedInputTokens");
    assertNonNegativeFinite(input.reasoningOutputTokens, "reasoningOutputTokens");
    assertNonEmpty(input.tokenUsageJson, "tokenUsageJson");
    const result = this.updateLarkMessageUsageStatement.run({
      larkMessageId: input.larkMessageId,
      inputTokens: Math.trunc(input.inputTokens),
      outputTokens: Math.trunc(input.outputTokens),
      cachedInputTokens: Math.trunc(input.cachedInputTokens),
      reasoningOutputTokens: Math.trunc(input.reasoningOutputTokens),
      tokenUsageJson: input.tokenUsageJson,
      updatedAt: this.now()
    });
    return result.changes === 0 ? undefined : this.requireLarkMessageById(input.larkMessageId);
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

  upsertLarkDocWatcher(input: UpsertLarkDocWatcherInput): LarkDocWatcherRecord {
    validateLarkDocWatcherInput(input);
    const now = this.now();
    this.upsertLarkDocWatcherStatement.run({
      fileType: input.fileType,
      fileToken: input.fileToken,
      threadId: input.threadId,
      watchMode: input.watchMode,
      watchUrl: input.watchUrl,
      createdAt: now,
      updatedAt: now
    });
    return this.requireLarkDocWatcherByFile(input.fileType, input.fileToken);
  }

  getLarkDocWatcherByFile(fileType: string, fileToken: string): LarkDocWatcherRecord | undefined {
    assertNonEmpty(fileType, "fileType");
    assertNonEmpty(fileToken, "fileToken");
    return mapLarkDocWatcherRow(this.selectLarkDocWatcherByFileStatement.get(fileType, fileToken));
  }

  listLarkDocWatchersByThread(threadId: string): LarkDocWatcherRecord[] {
    assertNonEmpty(threadId, "threadId");
    return this.selectLarkDocWatchersByThreadStatement.all(threadId).map((row) => mapRequiredLarkDocWatcherRow(row));
  }

  migrateLarkDocWatchersToThread(previousThreadId: string, nextThreadId: string): number {
    assertNonEmpty(previousThreadId, "previousThreadId");
    assertNonEmpty(nextThreadId, "nextThreadId");
    if (previousThreadId === nextThreadId) {
      return 0;
    }
    const result = this.migrateLarkDocWatchersToThreadStatement.run(
      nextThreadId,
      this.now(),
      previousThreadId,
      nextThreadId
    );
    return result.changes;
  }

  touchLarkDocWatcherCommentReceived(fileType: string, fileToken: string, receivedAt: number): boolean {
    assertNonEmpty(fileType, "fileType");
    assertNonEmpty(fileToken, "fileToken");
    assertNonNegativeFinite(receivedAt, "receivedAt");
    const result = this.updateLarkDocWatcherLastCommentStatement.run(
      Math.trunc(receivedAt),
      this.now(),
      fileType,
      fileToken
    );
    return result.changes > 0;
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
    const profile = resolveRequiredInputProfile(input);
    const profileCodexHome = input.profileCodexHome;
    return {
      conversationKey: input.conversationKey,
      type: input.type,
      chatId: input.chatId,
      name: input.name,
      responseMode: input.responseMode ?? (input.type === "p2p" ? "all" : "none"),
      profile,
      codexThreadId: input.codexThreadId,
      workspace: input.workspace,
      profileCodexHome: profileCodexHome!,
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

  private requireLarkMessageById(larkMessageId: string): LarkMessageRecord {
    const record = this.getLarkMessageById(larkMessageId);
    if (!record) {
      throw new TwinnyError(`Lark message ${larkMessageId} was not found`, "LARK_MESSAGE_NOT_FOUND");
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

  private requireLarkDocWatcherByFile(fileType: string, fileToken: string): LarkDocWatcherRecord {
    const record = this.getLarkDocWatcherByFile(fileType, fileToken);
    if (!record) {
      throw new TwinnyError(`Lark doc watcher ${fileType}/${fileToken} was not found`, "LARK_DOC_WATCHER_NOT_FOUND");
    }
    return record;
  }

  private markLarkMessagesTerminal(
    larkMessageIds: string[],
    statement: TwinnyStatement<[number, number, string]>
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
  db: TwinnyDatabase,
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
    profile: row.profile,
    codexThreadId: row.thread_id,
    workspace: row.workspace,
    profileCodexHome: row.profile_codex_home,
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
    workspace: row.workspace,
    name: row.name,
    larkThreadId: row.lark_thread_id ?? undefined,
    profile: row.profile,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
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
    docCommentId: row.doc_comment_id ?? undefined,
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
    rawEventJson: row.raw_event_json ?? undefined,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: row.cached_input_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    tokenUsageJson: row.token_usage_json
  };
}

function mapLarkDocWatcherRow(row: LarkDocWatcherRow | undefined): LarkDocWatcherRecord | undefined {
  if (!row) {
    return undefined;
  }
  return mapRequiredLarkDocWatcherRow(row);
}

function mapRequiredLarkDocWatcherRow(row: LarkDocWatcherRow): LarkDocWatcherRecord {
  return {
    id: row.id,
    fileType: row.file_type,
    fileToken: row.file_token,
    threadId: row.thread_id,
    watchMode: validLarkDocWatchMode(row.watch_mode) ? row.watch_mode : "owner",
    watchUrl: row.watch_url,
    lastCommentReceivedAt: row.last_comment_received_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validateNewConversation(input: NewConversationRecord): void {
  assertExpectedConversationKey(input.conversationKey, input.type, input.chatId);
  assertNonEmpty(input.name, "name");
  if (input.responseMode !== undefined) {
    assertValidResponseMode(input.responseMode);
  }
  assertValidProfile(resolveRequiredInputProfile(input));
  assertNonEmpty(input.codexThreadId, "codexThreadId");
  assertAbsolutePath(input.workspace, "workspace");
  assertNonEmpty(input.profileCodexHome, "profileCodexHome");
}

function validateCodexThreadInput(input: UpsertCodexThreadInput): void {
  assertNonEmpty(input.codexThreadId, "codexThreadId");
  assertValidConversationKey(input.conversationKey);
  if (input.workspace !== undefined) {
    assertAbsolutePath(input.workspace, "workspace");
  }
  assertValidProfile(resolveRequiredInputProfile(input));
  if (input.name !== undefined) {
    assertNonEmpty(input.name, "name");
  }
  if (input.model !== undefined) {
    assertNonEmpty(input.model, "model");
  }
  if (input.effort !== undefined) {
    assertNonEmpty(input.effort, "effort");
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
  if (input.workspace !== undefined) {
    assertAbsolutePath(input.workspace, "workspace");
  }
  assertValidProfile(resolveRequiredInputProfile(input));
  if (input.model !== undefined) {
    assertNonEmpty(input.model, "model");
  }
  if (input.effort !== undefined) {
    assertNonEmpty(input.effort, "effort");
  }
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
  if (input.docCommentId !== undefined) {
    assertNonEmpty(input.docCommentId, "docCommentId");
  }
}

function validateLarkDocWatcherInput(input: UpsertLarkDocWatcherInput): void {
  assertNonEmpty(input.fileType, "fileType");
  assertNonEmpty(input.fileToken, "fileToken");
  assertNonEmpty(input.threadId, "threadId");
  assertValidLarkDocWatchMode(input.watchMode);
  assertNonEmpty(input.watchUrl, "watchUrl");
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
  if (
    responseMode !== "all" &&
    responseMode !== "all_at" &&
    responseMode !== "owner" &&
    responseMode !== "owner_at" &&
    responseMode !== "none"
  ) {
    throw new TwinnyError(`Unsupported conversation response mode: ${responseMode}`, "CONVERSATION_RESPONSE_MODE_INVALID");
  }
}

function resolveRequiredInputProfile(input: { profile?: ProfileName }): ProfileName {
  const profile = resolveOptionalInputProfile(input);
  if (!profile) {
    throw new TwinnyError("profile must not be empty", "CONVERSATION_FIELD_EMPTY");
  }
  return profile;
}

function resolveOptionalInputProfile(input: { profile?: ProfileName }): ProfileName | undefined {
  return input.profile;
}

function assertValidProfile(profile: ProfileName): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(profile) || profile === "none") {
    throw new TwinnyError(`Unsupported profile: ${profile}`, "CONVERSATION_PROFILE_INVALID");
  }
}

function assertValidRouteKind(routeKind: LarkMessageRouteKind): void {
  if (
    routeKind !== "message" &&
    routeKind !== "steered_message" &&
    routeKind !== "queued_message" &&
    routeKind !== "doc_comment" &&
    routeKind !== "doc_comment_reply_steer" &&
    routeKind !== "side_message" &&
    routeKind !== "goal_message" &&
    routeKind !== "control_message" &&
    routeKind !== "card_action" &&
    routeKind !== "menu_action"
  ) {
    throw new TwinnyError(`Unsupported Lark message route kind: ${routeKind}`, "LARK_MESSAGE_ROUTE_KIND_INVALID");
  }
}

function assertValidLarkDocWatchMode(mode: LarkDocWatchMode): void {
  if (!validLarkDocWatchMode(mode)) {
    throw new TwinnyError(`Unsupported Lark doc watch mode: ${mode}`, "LARK_DOC_WATCH_MODE_INVALID");
  }
}

function validLarkDocWatchMode(mode: unknown): mode is LarkDocWatchMode {
  return mode === "owner" || mode === "all" || mode === "none";
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

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TwinnyError(`${field} must be a positive integer`, "CONVERSATION_FIELD_INVALID");
  }
}
