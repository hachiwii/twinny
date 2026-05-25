CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  name TEXT NOT NULL,
  profile TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  profile_codex_home TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  response_mode TEXT NOT NULL DEFAULT 'all'
);

CREATE INDEX idx_conversations_type_chat_id ON conversations(type, chat_id);
CREATE INDEX idx_conversations_thread_id ON conversations(thread_id);
CREATE INDEX idx_conversations_profile ON conversations(profile);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL UNIQUE,
  conversation_key TEXT NOT NULL,
  lark_thread_id TEXT,
  profile TEXT NOT NULL,
  forked_from_thread_id TEXT,
  forked_at INTEGER,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  token_usage_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  creator_open_id TEXT,
  card_message_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER NOT NULL DEFAULT 0,
  thread_has_rollout INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'default' CHECK(mode IN ('default', 'plan')),
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'working', 'waiting')),
  name TEXT NOT NULL DEFAULT '新会话',
  goal_status TEXT NOT NULL DEFAULT 'none' CHECK(goal_status IN ('none', 'active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete')),
  goal_updated_at INTEGER,
  model TEXT,
  effort TEXT
);

CREATE INDEX idx_threads_conversation_key ON threads(conversation_key);
CREATE UNIQUE INDEX idx_threads_conversation_lark_thread
  ON threads(conversation_key, lark_thread_id)
  WHERE lark_thread_id IS NOT NULL;

CREATE TABLE lark_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lark_message_id TEXT,
  event_id TEXT NOT NULL,
  lark_user_id TEXT NOT NULL,
  lark_group_id TEXT,
  lark_thread_id TEXT,
  conversation_key TEXT,
  thread_id TEXT,
  codex_turn_id TEXT,
  route_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  text TEXT NOT NULL,
  lark_create_time INTEGER,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  processing_started_at INTEGER,
  completed_at INTEGER,
  failed_at INTEGER,
  cleared_at INTEGER,
  raw_event_json TEXT,
  side_id INTEGER,
  agent_card_message_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  token_usage_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX idx_lark_messages_event_id
  ON lark_messages(event_id);
CREATE UNIQUE INDEX idx_lark_messages_lark_message_id
  ON lark_messages(lark_message_id)
  WHERE lark_message_id IS NOT NULL;
CREATE INDEX idx_lark_messages_conversation_route
  ON lark_messages(conversation_key, route_kind);
CREATE INDEX idx_lark_messages_conversation_turn
  ON lark_messages(conversation_key, thread_id, codex_turn_id, processing_started_at)
  WHERE thread_id IS NOT NULL
    AND codex_turn_id IS NOT NULL
    AND processing_started_at IS NOT NULL
    AND route_kind <> 'side_message';
CREATE UNIQUE INDEX idx_lark_messages_card_action_event_id
  ON lark_messages(event_id)
  WHERE route_kind = 'card_action';
CREATE INDEX idx_lark_messages_thread_turn
  ON lark_messages(thread_id, codex_turn_id);
