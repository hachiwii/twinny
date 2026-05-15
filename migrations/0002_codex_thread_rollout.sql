ALTER TABLE conversations
ADD COLUMN codex_thread_has_rollout INTEGER NOT NULL DEFAULT 1;
