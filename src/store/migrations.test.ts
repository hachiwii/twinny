import { describe, expect, it } from "vitest";

import { TwinnyDatabase } from "./db.js";
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
  it("loads the bundled store migrations", () => {
    const migrations = loadStoreMigrations();

    expect(currentStoreSchemaVersion).toBe(4);
    expect(migrations).toHaveLength(4);
    expect(migrations[0]).toMatchObject({
      version: 1,
      name: "0001_initial"
    });
    expect(migrations[1]).toMatchObject({
      version: 2,
      name: "0002_lark_doc_watcher"
    });
    expect(migrations[2]).toMatchObject({
      version: 3,
      name: "0003_lark_message_doc_comment_id"
    });
    expect(migrations[3]).toMatchObject({
      version: 4,
      name: "0004_thread_workspace"
    });
  });

  it("creates the current baseline schema", () => {
    const db = new TwinnyDatabase(":memory:");
    try {
      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);
      expect(getStoreSchemaVersion(db)).toBe(currentStoreSchemaVersion);

      const tables = db
        .prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(["conversations", "lark_doc_watcher", "lark_messages", "threads"]);

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
        { name: "effort", type: "TEXT", notnull: 0, pk: 0 },
        { name: "workspace", type: "TEXT", notnull: 1, pk: 0 },
        { name: "fork_source", type: "TEXT", notnull: 0, pk: 0 }
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
        { name: "agent_card_message_id", type: "TEXT", notnull: 0, pk: 0 },
        { name: "input_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "output_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "cached_input_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "reasoning_output_tokens", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "token_usage_json", type: "TEXT", notnull: 1, pk: 0 },
        { name: "doc_comment_id", type: "TEXT", notnull: 0, pk: 0 }
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
        "idx_lark_messages_doc_comment_id",
        "idx_lark_messages_event_id",
        "idx_lark_messages_lark_message_id",
        "idx_lark_messages_thread_turn"
      ]);

      const watcherColumns = db.prepare<[], TableColumnRow>("PRAGMA table_info(lark_doc_watcher)").all().map((row) => ({
        name: row.name,
        type: row.type,
        notnull: row.notnull,
        pk: row.pk
      }));
      expect(watcherColumns).toEqual([
        { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
        { name: "file_type", type: "TEXT", notnull: 1, pk: 0 },
        { name: "file_token", type: "TEXT", notnull: 1, pk: 0 },
        { name: "thread_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "watch_mode", type: "TEXT", notnull: 1, pk: 0 },
        { name: "watch_url", type: "TEXT", notnull: 1, pk: 0 },
        { name: "last_comment_received_at", type: "INTEGER", notnull: 0, pk: 0 },
        { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 }
      ]);

      const watcherIndexes = db
        .prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lark_doc_watcher' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(watcherIndexes).toEqual([
        "idx_lark_doc_watcher_thread_id",
        "sqlite_autoindex_lark_doc_watcher_1"
      ]);
    } finally {
      db.close();
    }
  });

  it("uses user_version so repeated migration does not recreate tables", () => {
    const db = new TwinnyDatabase(":memory:");
    try {
      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);
      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);

      const tables = db
        .prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(["conversations", "lark_doc_watcher", "lark_messages", "threads"]);
    } finally {
      db.close();
    }
  });

  it("backfills thread workspace from conversations when upgrading to version 4", () => {
    const db = new TwinnyDatabase(":memory:");
    const migrations = loadStoreMigrations();
    try {
      expect(runStoreMigrations(db, { migrations: migrations.slice(0, 3) })).toBe(3);

      db.exec(`
        INSERT INTO conversations (
          conversation_key,
          type,
          chat_id,
          name,
          profile,
          thread_id,
          workspace,
          profile_codex_home,
          created_at,
          updated_at,
          response_mode
        ) VALUES (
          'p2p_ou_guest',
          'p2p',
          'ou_guest',
          'Guest User',
          'guest',
          'thread_1',
          '/tmp/twinny/workspaces/p2p_ou_guest',
          '/tmp/twinny/profiles/guest/codex',
          100,
          100,
          'all'
        );

        INSERT INTO threads (
          thread_id,
          conversation_key,
          profile,
          created_at,
          updated_at
        ) VALUES
          ('thread_1', 'p2p_ou_guest', 'guest', 100, 100),
          ('thread_orphan', 'p2p_missing', 'guest', 100, 200);
      `);

      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);

      const rows = db
        .prepare<[], { thread_id: string; workspace: string }>(
          "SELECT thread_id, workspace FROM threads ORDER BY thread_id ASC"
        )
        .all();
      expect(rows).toEqual([
        { thread_id: "thread_1", workspace: "/tmp/twinny/workspaces/p2p_ou_guest" },
        { thread_id: "thread_orphan", workspace: "" }
      ]);
    } finally {
      db.close();
    }
  });

  it("drops persisted side thread fields when upgrading to version 4", () => {
    const db = new TwinnyDatabase(":memory:");
    const migrations = loadStoreMigrations();
    try {
      expect(runStoreMigrations(db, { migrations: migrations.slice(0, 3) })).toBe(3);

      db.exec(`
        INSERT INTO conversations (
          conversation_key,
          type,
          chat_id,
          name,
          profile,
          thread_id,
          workspace,
          profile_codex_home,
          created_at,
          updated_at,
          response_mode
        ) VALUES (
          'group_oc_group',
          'group',
          'oc_group',
          'Team Room',
          'guest',
          'thread_main',
          '/tmp/twinny/workspaces/group_oc_group',
          '/tmp/twinny/profiles/guest/codex',
          100,
          100,
          'all_at'
        );

        INSERT INTO threads (
          thread_id,
          conversation_key,
          lark_thread_id,
          profile,
          created_at,
          updated_at
        ) VALUES
          ('thread_main', 'group_oc_group', NULL, 'guest', 100, 100),
          ('thread_topic', 'group_oc_group', 'topic_1', 'guest', 100, 110),
          ('thread_side', 'group_oc_group', NULL, 'guest', 100, 120),
          ('thread_previous', 'group_oc_group', NULL, 'guest', 100, 130);

        INSERT INTO lark_messages (
          event_id,
          lark_user_id,
          conversation_key,
          thread_id,
          route_kind,
          status,
          text,
          received_at,
          updated_at,
          side_id
        ) VALUES (
          'event_side',
          'ou_guest',
          'group_oc_group',
          'thread_side',
          'side_message',
          'completed',
          'side work',
          120,
          120,
          1
        );
      `);

      expect(runStoreMigrations(db)).toBe(currentStoreSchemaVersion);

      const threadColumns = db.prepare<[], TableColumnRow>("PRAGMA table_info(threads)").all().map((row) => row.name);
      const messageColumns = db.prepare<[], TableColumnRow>("PRAGMA table_info(lark_messages)").all().map((row) => row.name);
      expect(threadColumns).not.toContain("category");
      expect(messageColumns).not.toContain("side_id");

      const threads = db
        .prepare<[], { thread_id: string }>("SELECT thread_id FROM threads ORDER BY thread_id ASC")
        .all();
      expect(threads).toEqual([
        { thread_id: "thread_main" },
        { thread_id: "thread_previous" },
        { thread_id: "thread_topic" }
      ]);

      const sideMessage = db
        .prepare<[], { thread_id: string }>("SELECT thread_id FROM lark_messages WHERE event_id = 'event_side'")
        .get();
      expect(sideMessage).toEqual({ thread_id: "thread_main" });

      const workspaces = db
        .prepare<[], { thread_id: string; workspace: string }>(
          "SELECT thread_id, workspace FROM threads ORDER BY thread_id ASC"
        )
        .all();
      expect(workspaces).toEqual([
        { thread_id: "thread_main", workspace: "/tmp/twinny/workspaces/group_oc_group" },
        { thread_id: "thread_previous", workspace: "/tmp/twinny/workspaces/group_oc_group" },
        { thread_id: "thread_topic", workspace: "/tmp/twinny/workspaces/group_oc_group" }
      ]);
    } finally {
      db.close();
    }
  });

  it("rejects databases newer than the bundled baseline", () => {
    const db = new TwinnyDatabase(":memory:");
    try {
      db.pragma(`user_version = ${currentStoreSchemaVersion + 1}`);

      expect(() => runStoreMigrations(db)).toThrow(/newer than supported version/);
    } finally {
      db.close();
    }
  });

  it("rejects a pre-1.0 development schema that shares the baseline user_version", () => {
    const db = new TwinnyDatabase(":memory:");
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
    const db = new TwinnyDatabase(":memory:");
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
