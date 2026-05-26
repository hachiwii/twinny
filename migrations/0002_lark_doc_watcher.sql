CREATE TABLE lark_doc_watcher (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_type TEXT NOT NULL,
  file_token TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  watch_mode TEXT NOT NULL DEFAULT 'owner' CHECK(watch_mode IN ('owner', 'all', 'none')),
  watch_url TEXT NOT NULL,
  last_comment_received_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(file_type, file_token)
);

CREATE INDEX idx_lark_doc_watcher_thread_id
  ON lark_doc_watcher(thread_id);
