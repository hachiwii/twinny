ALTER TABLE threads
  ADD COLUMN category TEXT NOT NULL DEFAULT 'previous_main' CHECK(category IN ('main', 'thread', 'side', 'previous_main'));

UPDATE threads
SET category = 'thread'
WHERE lark_thread_id IS NOT NULL;

UPDATE threads
SET category = 'side'
WHERE EXISTS (
  SELECT 1
  FROM lark_messages
  WHERE lark_messages.thread_id = threads.thread_id
    AND lark_messages.side_id IS NOT NULL
);

UPDATE threads
SET category = 'main'
WHERE EXISTS (
  SELECT 1
  FROM conversations
  WHERE conversations.conversation_key = threads.conversation_key
    AND conversations.thread_id = threads.thread_id
);
