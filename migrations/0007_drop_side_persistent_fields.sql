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
WHERE category = 'side';

ALTER TABLE threads DROP COLUMN category;

ALTER TABLE lark_messages DROP COLUMN side_id;
