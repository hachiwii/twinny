ALTER TABLE codex_threads RENAME TO threads;

ALTER TABLE threads
ADD COLUMN creator_open_id TEXT;

ALTER TABLE threads
ADD COLUMN card_message_id TEXT;

ALTER TABLE threads
ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE threads
ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE threads
ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE threads
ADD COLUMN reasoning_output_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE threads
ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE threads
ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_codex_threads_conversation_lark_thread;

CREATE UNIQUE INDEX idx_threads_conversation_lark_thread
ON threads(conversation_key, lark_thread_id)
WHERE lark_thread_id IS NOT NULL;

CREATE INDEX idx_lark_messages_codex_thread_turn
ON lark_messages(codex_thread_id, codex_turn_id);
