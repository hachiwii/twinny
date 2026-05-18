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
        { name: "context_window", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "thread_has_rollout", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "plan_mode", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "status", type: "TEXT", notnull: 1, pk: 0 }
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
        "idx_lark_messages_event_id",
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

  it("deduplicates existing lark messages by event id before adding the unique event index", () => {
    const db = new Database(":memory:");
    try {
      const migrationsToV9 = loadStoreMigrations().filter((migration) => migration.version <= 9);
      expect(runStoreMigrations(db, { migrations: migrationsToV9 })).toBe(9);

      const insert = db.prepare(`
        INSERT INTO lark_messages (
          lark_message_id,
          event_id,
          lark_user_id,
          route_kind,
          status,
          text,
          received_at,
          updated_at
        ) VALUES (?, ?, 'ou_user', 'message', 'completed', ?, ?, ?)
      `);
      insert.run("om_1", "event_dup", "first", 1000, 1000);
      insert.run("om_2", "event_dup", "second", 1100, 1100);

      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);
      expect(
        db.prepare<[], { text: string }>("SELECT text FROM lark_messages WHERE event_id = 'event_dup'").all()
      ).toEqual([{ text: "first" }]);
      const insertAfterMigration = db.prepare(`
        INSERT INTO lark_messages (
          lark_message_id,
          event_id,
          lark_user_id,
          route_kind,
          status,
          text,
          received_at,
          updated_at
        ) VALUES (?, ?, 'ou_user', 'message', 'completed', ?, ?, ?)
      `);
      expect(() => insertAfterMigration.run("om_3", "event_dup", "third", 1200, 1200)).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it("converts legacy project conversations into group conversations", () => {
    const db = new Database(":memory:");
    try {
      const migrationsToV10 = loadStoreMigrations().filter((migration) => migration.version <= 10);
      expect(runStoreMigrations(db, { migrations: migrationsToV10 })).toBe(10);

      db.prepare(`
        INSERT INTO conversations (
          conversation_key,
          type,
          chat_id,
          name,
          role,
          thread_id,
          workspace,
          role_codex_home,
          created_at,
          updated_at,
          response_mode,
          chat_mode
        ) VALUES (
          'group_oc_project',
          'project',
          'oc_project',
          'Legacy Project',
          'owner',
          'thread_project',
          '/tmp/twinny/workspaces/group_oc_project',
          '/tmp/twinny/roles/owner/codex',
          100,
          100,
          'all',
          NULL
        )
      `).run();

      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);
      expect(
        db.prepare<[], { type: string; chat_mode: string | null }>(`
          SELECT type, chat_mode
          FROM conversations
          WHERE conversation_key = 'group_oc_project'
        `).get()
      ).toEqual({ type: "group", chat_mode: null });
    } finally {
      db.close();
    }
  });

  it("moves rollout state from conversations into thread rows", () => {
    const db = new Database(":memory:");
    try {
      const migrationsToV8 = loadStoreMigrations().filter((migration) => migration.version <= 8);
      expect(runStoreMigrations(db, { migrations: migrationsToV8 })).toBe(8);

      db.prepare(`
        INSERT INTO conversations (
          conversation_key,
          type,
          chat_id,
          name,
          role,
          thread_id,
          thread_has_rollout,
          workspace,
          role_codex_home,
          created_at,
          updated_at,
          response_mode
        ) VALUES (?, 'group', ?, ?, 'owner', ?, ?, ?, ?, 1000, 1000, 'at')
      `).run(
        "group_oc_main_started",
        "oc_main_started",
        "Main Started",
        "thread_main_started",
        1,
        "/tmp/workspaces/group_oc_main_started",
        "/tmp/roles/owner/codex"
      );
      db.prepare(`
        INSERT INTO conversations (
          conversation_key,
          type,
          chat_id,
          name,
          role,
          thread_id,
          thread_has_rollout,
          workspace,
          role_codex_home,
          created_at,
          updated_at,
          response_mode
        ) VALUES (?, 'group', ?, ?, 'owner', ?, ?, ?, ?, 1000, 1000, 'at')
      `).run(
        "group_oc_main_empty",
        "oc_main_empty",
        "Main Empty",
        "thread_main_empty",
        0,
        "/tmp/workspaces/group_oc_main_empty",
        "/tmp/roles/owner/codex"
      );
      db.prepare(`
        INSERT INTO threads (
          thread_id,
          conversation_key,
          lark_thread_id,
          role,
          total_tokens,
          token_usage_json,
          created_at,
          updated_at
        ) VALUES (?, ?, NULL, ?, 0, '{}', 1000, 1000)
      `).run("thread_main_started", "group_oc_main_started", "owner");
      db.prepare(`
        INSERT INTO threads (
          thread_id,
          conversation_key,
          lark_thread_id,
          role,
          total_tokens,
          token_usage_json,
          created_at,
          updated_at
        ) VALUES (?, ?, NULL, ?, 0, '{}', 1000, 1000)
      `).run("thread_main_empty", "group_oc_main_empty", "owner");
      db.prepare(`
        INSERT INTO threads (
          thread_id,
          conversation_key,
          lark_thread_id,
          role,
          total_tokens,
          token_usage_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, 0, '{}', 1000, 1000)
      `).run("thread_empty", "group_oc_group", "topic_empty", "owner");
      db.prepare(`
        INSERT INTO threads (
          thread_id,
          conversation_key,
          lark_thread_id,
          role,
          total_tokens,
          token_usage_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, 0, '{}', 1000, 1000)
      `).run("thread_started", "group_oc_group", "topic_started", "owner");
      db.prepare(`
        INSERT INTO lark_messages (
          lark_message_id,
          event_id,
          lark_user_id,
          conversation_key,
          thread_id,
          codex_turn_id,
          route_kind,
          status,
          text,
          received_at,
          updated_at,
          processing_started_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'message', 'completed', 'hello', 1100, 1100, 1100)
      `).run("om_started", "event_started", "ou_owner", "group_oc_group", "thread_started", "turn_1");

      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);
      const conversationColumns = db.prepare<[], TableColumnRow>("PRAGMA table_info(conversations)").all();
      expect(conversationColumns.some((column) => column.name === "thread_has_rollout")).toBe(false);
      const rows = db
        .prepare<[], { thread_id: string; thread_has_rollout: number }>(`
          SELECT thread_id, thread_has_rollout
          FROM threads
          ORDER BY thread_id
        `)
        .all();
      expect(rows).toEqual([
        { thread_id: "thread_empty", thread_has_rollout: 0 },
        { thread_id: "thread_main_empty", thread_has_rollout: 0 },
        { thread_id: "thread_main_started", thread_has_rollout: 1 },
        { thread_id: "thread_started", thread_has_rollout: 1 }
      ]);
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

  it("repairs a legacy version-8 schema that was labeled as upgraded but still stores codex_* thread columns", () => {
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
          lark_message_id TEXT,
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
        CREATE UNIQUE INDEX idx_conversations_codex_thread_id ON conversations(codex_thread_id);
        CREATE UNIQUE INDEX idx_codex_threads_conversation_lark_thread ON codex_threads(conversation_key, lark_thread_id);
        CREATE INDEX idx_lark_messages_codex_thread_turn ON lark_messages(codex_thread_id, codex_turn_id);
        PRAGMA user_version = 8;
      `);

      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);

      const conversations = db.prepare<[], TableColumnRow>("PRAGMA table_info(conversations)").all().map((row) => row.name);
      const threads = db.prepare<[], TableColumnRow>("PRAGMA table_info(threads)").all().map((row) => row.name);
      const larkMessages = db.prepare<[], TableColumnRow>("PRAGMA table_info(lark_messages)").all().map((row) => row.name);

      expect(conversations).toContain("thread_id");
      expect(conversations).not.toContain("codex_thread_id");
      expect(threads).toContain("thread_id");
      expect(threads).not.toContain("codex_thread_id");
      expect(threads).toContain("forked_from_thread_id");
      expect(threads).not.toContain("forked_from_codex_thread_id");
      expect(larkMessages).toContain("thread_id");
      expect(larkMessages).not.toContain("codex_thread_id");
      expect(db.pragma("user_version", { simple: true })).toBe(currentStoreSchemaVersion);
    } finally {
      db.close();
    }
  });
});
