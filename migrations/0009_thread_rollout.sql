ALTER TABLE threads
ADD COLUMN thread_has_rollout INTEGER NOT NULL DEFAULT 1;

UPDATE threads
SET thread_has_rollout = COALESCE(
  (
    SELECT conversations.thread_has_rollout
    FROM conversations
    WHERE conversations.thread_id = threads.thread_id
    LIMIT 1
  ),
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM lark_messages
      WHERE lark_messages.thread_id = threads.thread_id
        AND lark_messages.codex_turn_id IS NOT NULL
    ) THEN 1
    ELSE 0
  END
);

ALTER TABLE conversations
DROP COLUMN thread_has_rollout;
