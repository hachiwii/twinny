ALTER TABLE conversations
ADD COLUMN chat_mode TEXT;

UPDATE conversations
SET chat_mode = CASE
  WHEN type = 'topic_group' THEN 'topic'
  WHEN type = 'group' THEN 'group'
  ELSE NULL
END
WHERE chat_mode IS NULL;
