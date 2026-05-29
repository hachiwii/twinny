CREATE TABLE cron_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  message_text TEXT NOT NULL,
  timezone TEXT NOT NULL,
  last_run_at INTEGER,
  last_lark_message_id TEXT,
  created_by_open_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_cron_jobs_conversation
  ON cron_jobs(conversation_key, created_at, id);
CREATE INDEX idx_cron_jobs_thread
  ON cron_jobs(thread_id);
