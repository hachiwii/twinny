UPDATE codex_threads
SET conversation_key = CASE
  WHEN conversation_key LIKE 'p2p:%' THEN 'p2p_' || substr(conversation_key, 5)
  WHEN conversation_key LIKE 'group:%' THEN 'group_' || substr(conversation_key, 7)
  ELSE conversation_key
END
WHERE conversation_key LIKE 'p2p:%' OR conversation_key LIKE 'group:%';

UPDATE lark_messages
SET conversation_key = CASE
  WHEN conversation_key LIKE 'p2p:%' THEN 'p2p_' || substr(conversation_key, 5)
  WHEN conversation_key LIKE 'group:%' THEN 'group_' || substr(conversation_key, 7)
  ELSE conversation_key
END
WHERE conversation_key LIKE 'p2p:%' OR conversation_key LIKE 'group:%';

UPDATE conversations
SET conversation_key = CASE
  WHEN conversation_key LIKE 'p2p:%' THEN 'p2p_' || substr(conversation_key, 5)
  WHEN conversation_key LIKE 'group:%' THEN 'group_' || substr(conversation_key, 7)
  ELSE conversation_key
END
WHERE (conversation_key LIKE 'p2p:%' AND NOT EXISTS (
  SELECT 1 FROM conversations c2 WHERE c2.conversation_key = 'p2p_' || substr(conversations.conversation_key, 5)
))
OR (conversation_key LIKE 'group:%' AND NOT EXISTS (
  SELECT 1 FROM conversations c2 WHERE c2.conversation_key = 'group_' || substr(conversations.conversation_key, 7)
));

DELETE FROM conversations
WHERE (conversation_key LIKE 'p2p:%' AND EXISTS (
  SELECT 1 FROM conversations c2 WHERE c2.conversation_key = 'p2p_' || substr(conversations.conversation_key, 5)
))
OR (conversation_key LIKE 'group:%' AND EXISTS (
  SELECT 1 FROM conversations c2 WHERE c2.conversation_key = 'group_' || substr(conversations.conversation_key, 7)
));

UPDATE conversations
SET workspace = replace(workspace, '/p2p:', '/p2p_')
WHERE workspace LIKE '%/p2p:%';

UPDATE conversations
SET workspace = replace(workspace, '/group:', '/group_')
WHERE workspace LIKE '%/group:%';
