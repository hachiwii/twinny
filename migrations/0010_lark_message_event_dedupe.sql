DELETE FROM lark_messages
WHERE id NOT IN (
  SELECT MIN(id)
  FROM lark_messages
  GROUP BY event_id
);

CREATE UNIQUE INDEX idx_lark_messages_event_id
ON lark_messages(event_id);
