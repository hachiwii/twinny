UPDATE threads
SET name = '主会话'
WHERE EXISTS (
  SELECT 1
  FROM conversations
  WHERE conversations.conversation_key = threads.conversation_key
    AND conversations.thread_id = threads.thread_id
);
