ALTER TABLE threads ADD COLUMN workspace TEXT NOT NULL DEFAULT '';

UPDATE threads
SET workspace = COALESCE(
  (
    SELECT conversations.workspace
    FROM conversations
    WHERE conversations.conversation_key = threads.conversation_key
  ),
  ''
);
