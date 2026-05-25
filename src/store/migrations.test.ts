import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { currentStoreSchemaVersion, getStoreSchemaVersion, loadStoreMigrations, runStoreMigrations } from "./migrations.js";

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
  it("loads the 1.0 baseline migration", () => {
    const migrations = loadStoreMigrations();

    expect(currentStoreSchemaVersion).toBe(1);
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({
      version: 1,
      name: "0001_initial"
    });
  });

  it("creates the current baseline schema", () => {
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

      const conversationColumns = db.prepare<[], TableColumnRow>("PRAGMA table_info(conversations)").all().map((row) => ({
        name: row.name,
        type: row.type,
        notnull: row.notnull,
        pk: row.pk
      }));
      expect(conversationColumns).toEqual([
        { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
        { name: "conversation_key", type: "TEXT", notnull: 1, pk: 0 },
        { name: "type", type: "TEXT", notnull: 1, pk: 0 },
        { name: "chat_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "name", type: "TEXT", notnull: 1, pk: 0 },
        { name: "profile", type: "TEXT", notnull: 1, pk: 0 },
        { name: "thread_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "workspace", type: "TEXT", notnull: 1, pk: 0 },
        { name: "profile_codex_home", type: "TEXT", notnull: 1, pk: 0 },
        { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "response_mode", type: "TEXT", notnull: 1, pk: 0 }
      ]);

      const conversationIndexes = db
        .prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversations' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(conversationIndexes).toEqual([
        "idx_conversations_profile",
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
        { name: "profile", type: "TEXT", notnull: 1, pk: 0 },
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
        { name: "context_window", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "thread_has_rollout", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "mode", type: "TEXT", notnull: 1, pk: 0 },
        { name: "status", type: "TEXT", notnull: 1, pk: 0 },
        { name: "name", type: "TEXT", notnull: 1, pk: 0 },
        { name: "goal_status", type: "TEXT", notnull: 1, pk: 0 },
        { name: "goal_updated_at", type: "INTEGER", notnull: 0, pk: 0 },
        { name: "model", type: "TEXT", notnull: 0, pk: 0 },
        { name: "effort", type: "TEXT", notnull: 0, pk: 0 }
      ]);

      const threadIndexes = db
        .prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'threads' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(threadIndexes).toEqual([
        "idx_threads_conversation_key",
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
        { name: "raw_event_json", type: "TEXT", notnull: 0, pk: 0 },
        { name: "side_id", type: "INTEGER", notnull: 0, pk: 0 },
        { name: "agent_card_message_id", type: "TEXT", notnull: 0, pk: 0 },
        { name: "input_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "output_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "cached_input_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "reasoning_output_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "token_usage_json", type: "TEXT", notnull: 1, pk: 0 }
      ]);

      const messageIndexes = db
        .prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lark_messages' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(messageIndexes).toEqual([
        "idx_lark_messages_card_action_event_id",
        "idx_lark_messages_conversation_route",
        "idx_lark_messages_conversation_turn",
        "idx_lark_messages_event_id",
        "idx_lark_messages_lark_message_id",
        "idx_lark_messages_thread_turn"
      ]);
    } finally {
      db.close();
    }
  });

  it("uses user_version so repeated migration does not recreate tables", () => {
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

  it("rejects databases newer than the bundled baseline", () => {
    const db = new Database(":memory:");
    try {
      db.pragma(`user_version = ${currentStoreSchemaVersion + 1}`);

      expect(() => runStoreMigrations(db)).toThrow(/newer than supported version/);
    } finally {
      db.close();
    }
  });

  it("rejects a pre-1.0 development schema that shares the baseline user_version", () => {
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
          updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
      `);

      expect(() => runStoreMigrations(db)).toThrow(/does not match the 1\.0 baseline/);
    } finally {
      db.close();
    }
  });

  it("rejects non-contiguous custom migrations", () => {
    const db = new Database(":memory:");
    try {
      expect(() =>
        runStoreMigrations(db, {
          migrations: [
            {
              version: 2,
              name: "0002_gap",
              sql: "CREATE TABLE skipped_baseline (id INTEGER PRIMARY KEY)"
            }
          ]
        })
      ).toThrow(/not contiguous after version 0/);
    } finally {
      db.close();
    }
  });
});
