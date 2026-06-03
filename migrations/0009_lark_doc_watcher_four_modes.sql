ALTER TABLE lark_doc_watcher RENAME TO lark_doc_watcher_old;

CREATE TABLE lark_doc_watcher (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_type TEXT NOT NULL,
  file_token TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  watch_mode TEXT NOT NULL DEFAULT 'owner_at' CHECK(watch_mode IN ('owner_at', 'owner', 'all_at', 'all')),
  watch_url TEXT NOT NULL,
  last_comment_received_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(file_type, file_token)
);

INSERT INTO lark_doc_watcher (
  id,
  file_type,
  file_token,
  thread_id,
  watch_mode,
  watch_url,
  last_comment_received_at,
  created_at,
  updated_at
)
SELECT
  id,
  file_type,
  file_token,
  thread_id,
  CASE watch_mode
    WHEN 'owner' THEN 'owner_at'
    WHEN 'all' THEN 'all_at'
    ELSE watch_mode
  END,
  watch_url,
  last_comment_received_at,
  created_at,
  updated_at
FROM lark_doc_watcher_old
WHERE watch_mode IN ('owner', 'all', 'owner_at', 'all_at');

DROP TABLE lark_doc_watcher_old;

CREATE INDEX idx_lark_doc_watcher_thread_id
  ON lark_doc_watcher(thread_id);
