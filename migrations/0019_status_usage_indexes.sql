CREATE INDEX IF NOT EXISTS idx_threads_conversation_key
ON threads(conversation_key);

CREATE INDEX IF NOT EXISTS idx_lark_messages_conversation_route
ON lark_messages(conversation_key, route_kind);

CREATE INDEX IF NOT EXISTS idx_lark_messages_conversation_turn
ON lark_messages(conversation_key, thread_id, codex_turn_id, processing_started_at)
WHERE thread_id IS NOT NULL
  AND codex_turn_id IS NOT NULL
  AND processing_started_at IS NOT NULL
  AND route_kind <> 'side_message';
