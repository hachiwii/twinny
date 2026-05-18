import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { currentStoreSchemaVersion, getStoreSchemaVersion, runStoreMigrations } from "./migrations.js";

interface SqliteNameRow {
  name: string;
}

interface TableColumnRow {
  name: string;
  type: string;
  notnull: 0 | 1;
  pk: 0 | 1;
}

describe("store migrations", () => {
  it("creates the current conversations table", () => {
    const db = new Database(":memory:");
    try {
      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);
      expect(getStoreSchemaVersion(db)).toBe(currentStoreSchemaVersion);

      const tables = db
        .prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(["conversations", "lark_messages", "threads"]);

      const columns = db.prepare<[], TableColumnRow>("PRAGMA table_info(conversations)").all().map((row) => ({
        name: row.name,
        type: row.type,
        notnull: row.notnull,
        pk: row.pk
      }));
      expect(columns).toEqual([
        { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
        { name: "conversation_key", type: "TEXT", notnull: 1, pk: 0 },
        { name: "type", type: "TEXT", notnull: 1, pk: 0 },
        { name: "chat_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "name", type: "TEXT", notnull: 1, pk: 0 },
        { name: "role", type: "TEXT", notnull: 1, pk: 0 },
        { name: "thread_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "workspace", type: "TEXT", notnull: 1, pk: 0 },
        { name: "role_codex_home", type: "TEXT", notnull: 1, pk: 0 },
        { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "thread_has_rollout", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "response_mode", type: "TEXT", notnull: 1, pk: 0 },
        { name: "chat_mode", type: "TEXT", notnull: 0, pk: 0 }
      ]);

      const indexes = db
        .prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversations' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual([
        "idx_conversations_role",
        "idx_conversations_thread_id",
        "idx_conversations_type_chat_id",
        "sqlite_autoindex_conversations_1"
      ]);

      const threadColumns = db.prepare<[], TableColumnRow>("PRAGMA table_info(threads)").all().map((row) => ({
        name: row.name,
        type: row.type,
        notnull: row.notnull,
        pk: row.pk
      }));
      expect(threadColumns).toEqual([
        { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
        { name: "thread_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "conversation_key", type: "TEXT", notnull: 1, pk: 0 },
        { name: "lark_thread_id", type: "TEXT", notnull: 0, pk: 0 },
        { name: "role", type: "TEXT", notnull: 1, pk: 0 },
        { name: "forked_from_thread_id", type: "TEXT", notnull: 0, pk: 0 },
        { name: "forked_at", type: "INTEGER", notnull: 0, pk: 0 },
        { name: "total_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "token_usage_json", type: "TEXT", notnull: 1, pk: 0 },
        { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "creator_open_id", type: "TEXT", notnull: 0, pk: 0 },
        { name: "card_message_id", type: "TEXT", notnull: 0, pk: 0 },
        { name: "input_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "output_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "cached_input_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "reasoning_output_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "context_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "context_window", type: "INTEGER", notnull: 1, pk: 0 }
      ]);
      const threadIndexes = db
        .prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'threads' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(threadIndexes).toEqual([
        "idx_threads_conversation_lark_thread",
        "sqlite_autoindex_threads_1"
      ]);

      const messageColumns = db.prepare<[], TableColumnRow>("PRAGMA table_info(lark_messages)").all().map((row) => ({
        name: row.name,
        type: row.type,
        notnull: row.notnull,
        pk: row.pk
      }));
      expect(messageColumns).toEqual([
        { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
        { name: "lark_message_id", type: "TEXT", notnull: 0, pk: 0 },
        { name: "event_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "lark_user_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "lark_group_id", type: "TEXT", notnull: 0, pk: 0 },
        { name: "lark_thread_id", type: "TEXT", notnull: 0, pk: 0 },
        { name: "conversation_key", type: "TEXT", notnull: 0, pk: 0 },
        { name: "thread_id", type: "TEXT", notnull: 0, pk: 0 },
        { name: "codex_turn_id", type: "TEXT", notnull: 0, pk: 0 },
        { name: "route_kind", type: "TEXT", notnull: 1, pk: 0 },
        { name: "status", type: "TEXT", notnull: 1, pk: 0 },
        { name: "text", type: "TEXT", notnull: 1, pk: 0 },
        { name: "lark_create_time", type: "INTEGER", notnull: 0, pk: 0 },
        { name: "received_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "processing_started_at", type: "INTEGER", notnull: 0, pk: 0 },
        { name: "completed_at", type: "INTEGER", notnull: 0, pk: 0 },
        { name: "failed_at", type: "INTEGER", notnull: 0, pk: 0 },
        { name: "cleared_at", type: "INTEGER", notnull: 0, pk: 0 },
        { name: "raw_event_json", type: "TEXT", notnull: 0, pk: 0 }
      ]);
      const messageIndexes = db
        .prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lark_messages' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(messageIndexes).toEqual([
        "idx_lark_messages_card_action_event_id",
        "idx_lark_messages_lark_message_id",
        "idx_lark_messages_thread_turn"
      ]);
    } finally {
      db.close();
    }
  });

  it("uses user_version so repeated migration does not create extra tables", () => {
    const db = new Database(":memory:");
    try {
      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);
      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);

      const tables = db
        .prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(["conversations", "lark_messages", "threads"]);
    } finally {
      db.close();
    }
  });

  it("migrates v3 user names into p2p conversations and drops users", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
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
          updated_at INTEGER NOT NULL,
          codex_thread_has_rollout INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lark_user_id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT 'guest',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE codex_threads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          codex_thread_id TEXT NOT NULL UNIQUE,
          conversation_key TEXT NOT NULL,
          lark_thread_id TEXT,
          role TEXT NOT NULL,
          forked_from_codex_thread_id TEXT,
          forked_at INTEGER,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          token_usage_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE lark_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lark_message_id TEXT NOT NULL UNIQUE,
          event_id TEXT NOT NULL,
          lark_user_id TEXT NOT NULL,
          lark_group_id TEXT,
          lark_thread_id TEXT,
          conversation_key TEXT,
          codex_thread_id TEXT,
          codex_turn_id TEXT,
          route_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          text TEXT NOT NULL,
          lark_create_time INTEGER,
          received_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          processing_started_at INTEGER,
          completed_at INTEGER,
          failed_at INTEGER,
          cleared_at INTEGER,
          raw_event_json TEXT
        );
        INSERT INTO conversations (
          conversation_key, type, chat_id, name, role, codex_thread_id,
          workspace, role_codex_home, created_at, updated_at, codex_thread_has_rollout
        ) VALUES (
          'p2p_ou_user', 'p2p', 'ou_user', '', 'guest', 'thread-1',
          '/tmp/workspaces/p2p_ou_user', '/tmp/roles/guest/codex', 1, 1, 1
        );
        INSERT INTO users (
          lark_user_id, name, role, created_at, updated_at, last_seen_at
        ) VALUES (
          'ou_user', 'Stored User', 'guest', 1, 1, 1
        );
        PRAGMA user_version = 3;
      `);

      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);

      expect(
        db.prepare<[], { name: string; response_mode: string; chat_mode: string | null }>(
          "SELECT name, response_mode, chat_mode FROM conversations WHERE conversation_key = 'p2p_ou_user'"
        ).get()
      ).toEqual({ name: "Stored User", response_mode: "all", chat_mode: null });
      expect(
        db.prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
        ).get()
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
