ALTER TABLE threads
ADD COLUMN goal_status TEXT NOT NULL DEFAULT 'none'
CHECK(goal_status IN ('none', 'active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'));

ALTER TABLE threads
ADD COLUMN goal_updated_at INTEGER;

UPDATE threads
SET goal_status = 'active',
    goal_updated_at = (
      SELECT COALESCE(
        MAX(COALESCE(lark_messages.processing_started_at, lark_messages.updated_at, lark_messages.received_at)),
        threads.updated_at
      )
      FROM lark_messages
      WHERE lark_messages.thread_id = threads.thread_id
        AND lark_messages.status = 'processing'
        AND lark_messages.route_kind = 'goal_message'
    )
WHERE EXISTS (
  SELECT 1
  FROM lark_messages
  WHERE lark_messages.thread_id = threads.thread_id
    AND lark_messages.status = 'processing'
    AND lark_messages.route_kind = 'goal_message'
);
