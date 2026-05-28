ALTER TABLE threads RENAME TO threads_v4;

CREATE TABLE threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL UNIQUE,
  conversation_key TEXT NOT NULL,
  workspace TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '新会话',
  lark_thread_id TEXT,
  profile TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  parent_thread TEXT,
  create_method TEXT NOT NULL DEFAULT 'init_main' CHECK(create_method IN ('init_main', 'new_main', 'fresh', 'fork', 'resume')),
  create_request_text TEXT,
  forked_at INTEGER,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  token_usage_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  creator_open_id TEXT,
  card_message_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER NOT NULL DEFAULT 0,
  thread_has_rollout INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'default' CHECK(mode IN ('default', 'plan')),
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'working', 'waiting')),
  goal_status TEXT NOT NULL DEFAULT 'none' CHECK(goal_status IN ('none', 'active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete')),
  goal_updated_at INTEGER
);

INSERT INTO threads (
  id,
  thread_id,
  conversation_key,
  workspace,
  name,
  lark_thread_id,
  profile,
  model,
  effort,
  parent_thread,
  create_method,
  create_request_text,
  forked_at,
  total_tokens,
  token_usage_json,
  created_at,
  updated_at,
  creator_open_id,
  card_message_id,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  reasoning_output_tokens,
  context_tokens,
  context_window,
  thread_has_rollout,
  mode,
  status,
  goal_status,
  goal_updated_at
)
SELECT
  id,
  thread_id,
  conversation_key,
  workspace,
  name,
  lark_thread_id,
  profile,
  model,
  effort,
  forked_from_thread_id,
  CASE
    WHEN fork_source = 'external_resume' THEN 'resume'
    WHEN forked_from_thread_id IS NOT NULL THEN 'fork'
    WHEN lark_thread_id IS NOT NULL THEN 'fresh'
    ELSE 'init_main'
  END,
  NULL,
  forked_at,
  total_tokens,
  token_usage_json,
  created_at,
  updated_at,
  creator_open_id,
  card_message_id,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  reasoning_output_tokens,
  context_tokens,
  context_window,
  thread_has_rollout,
  mode,
  status,
  goal_status,
  goal_updated_at
FROM threads_v4;

DROP TABLE threads_v4;

CREATE INDEX idx_threads_conversation_key ON threads(conversation_key);
CREATE UNIQUE INDEX idx_threads_conversation_lark_thread
  ON threads(conversation_key, lark_thread_id)
  WHERE lark_thread_id IS NOT NULL;
CREATE INDEX idx_threads_parent_create_method
  ON threads(parent_thread, create_method, created_at)
  WHERE parent_thread IS NOT NULL;
