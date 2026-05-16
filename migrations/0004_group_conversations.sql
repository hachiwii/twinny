UPDATE conversations
SET name = (
  SELECT users.name
  FROM users
  WHERE users.lark_user_id = conversations.chat_id
    AND users.name <> ''
  LIMIT 1
)
WHERE type = 'p2p'
  AND EXISTS (
    SELECT 1
    FROM users
    WHERE users.lark_user_id = conversations.chat_id
      AND users.name <> ''
  );

ALTER TABLE conversations
ADD COLUMN response_mode TEXT NOT NULL DEFAULT 'all';

DROP TABLE IF EXISTS users;

CREATE UNIQUE INDEX idx_codex_threads_conversation_lark_thread
ON codex_threads(conversation_key, lark_thread_id)
WHERE lark_thread_id IS NOT NULL;
