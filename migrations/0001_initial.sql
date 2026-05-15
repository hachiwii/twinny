CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  codex_thread_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  role_codex_home TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_conversations_type_chat_id ON conversations(type, chat_id);
CREATE INDEX idx_conversations_codex_thread_id ON conversations(codex_thread_id);
CREATE INDEX idx_conversations_role ON conversations(role);
