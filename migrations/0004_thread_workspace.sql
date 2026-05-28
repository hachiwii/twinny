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

CREATE TEMP TABLE twinny_side_thread_ids AS
SELECT DISTINCT thread_id
FROM lark_messages
WHERE route_kind = 'side_message'
  AND side_id IS NOT NULL
  AND thread_id IS NOT NULL;

ALTER TABLE threads
  ADD COLUMN fork_source TEXT CHECK(fork_source IS NULL OR fork_source IN ('external_resume'));

UPDATE lark_messages
SET thread_id = COALESCE(
  (
    SELECT topic_threads.thread_id
    FROM threads AS topic_threads
    WHERE topic_threads.conversation_key = lark_messages.conversation_key
      AND topic_threads.lark_thread_id = lark_messages.lark_thread_id
    LIMIT 1
  ),
  (
    SELECT conversations.thread_id
    FROM conversations
    WHERE conversations.conversation_key = lark_messages.conversation_key
  ),
  thread_id
)
WHERE route_kind = 'side_message';

DELETE FROM threads
WHERE thread_id IN (SELECT thread_id FROM twinny_side_thread_ids);

DROP TABLE twinny_side_thread_ids;

ALTER TABLE lark_messages DROP COLUMN side_id;
