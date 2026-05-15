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
      expect(tables).toEqual(["conversations"]);

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
        { name: "codex_thread_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "workspace", type: "TEXT", notnull: 1, pk: 0 },
        { name: "role_codex_home", type: "TEXT", notnull: 1, pk: 0 },
        { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "codex_thread_has_rollout", type: "INTEGER", notnull: 1, pk: 0 }
      ]);

      const indexes = db
        .prepare<[], SqliteNameRow>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversations' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual([
        "idx_conversations_codex_thread_id",
        "idx_conversations_role",
        "idx_conversations_type_chat_id",
        "sqlite_autoindex_conversations_1"
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
      expect(tables).toEqual(["conversations"]);
    } finally {
      db.close();
    }
  });
});
