CREATE TABLE lark_messages_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lark_message_id TEXT,
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

INSERT INTO lark_messages_new (
  id,
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
  processing_started_at,
  completed_at,
  failed_at,
  cleared_at,
  raw_event_json
)
SELECT
  id,
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
  processing_started_at,
  completed_at,
  failed_at,
  cleared_at,
  raw_event_json
FROM lark_messages;

DROP TABLE lark_messages;
ALTER TABLE lark_messages_new RENAME TO lark_messages;

CREATE UNIQUE INDEX idx_lark_messages_lark_message_id
ON lark_messages(lark_message_id)
WHERE lark_message_id IS NOT NULL;

CREATE UNIQUE INDEX idx_lark_messages_card_action_event_id
ON lark_messages(event_id)
WHERE route_kind = 'card_action';
