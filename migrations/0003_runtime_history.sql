CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lark_user_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'guest',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE codex_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codex_thread_id TEXT NOT NULL UNIQUE,
  conversation_key TEXT NOT NULL,
  lark_thread_id TEXT,
  role TEXT NOT NULL,
  forked_from_codex_thread_id TEXT,
  forked_at INTEGER,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  token_usage_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO codex_threads (
  codex_thread_id,
  conversation_key,
  lark_thread_id,
  role,
  total_tokens,
  token_usage_json,
  created_at,
  updated_at
)
SELECT
  codex_thread_id,
  conversation_key,
  NULL,
  role,
  0,
  '{}',
  created_at,
  updated_at
FROM conversations;

CREATE TABLE lark_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lark_message_id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  lark_user_id TEXT NOT NULL,
  lark_group_id TEXT,
  lark_thread_id TEXT,
  conversation_key TEXT,
  codex_thread_id TEXT,
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
  raw_event_json TEXT
);
