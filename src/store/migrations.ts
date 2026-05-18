import fs from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";

import { TwinnyError } from "../errors.js";

export interface StoreMigration {
  version: number;
  name: string;
  sql: string;
}

export interface RunMigrationsOptions {
  migrations?: StoreMigration[];
}

export const currentStoreSchemaVersion = 12;

const initialMigrationFile = fileURLToPath(new URL("../../migrations/0001_initial.sql", import.meta.url));
const threadRolloutMigrationFile = fileURLToPath(new URL("../../migrations/0002_codex_thread_rollout.sql", import.meta.url));
const runtimeHistoryMigrationFile = fileURLToPath(new URL("../../migrations/0003_runtime_history.sql", import.meta.url));
const groupConversationsMigrationFile = fileURLToPath(new URL("../../migrations/0004_group_conversations.sql", import.meta.url));
const cardActionsMigrationFile = fileURLToPath(new URL("../../migrations/0005_card_actions.sql", import.meta.url));
const conversationChatModeMigrationFile = fileURLToPath(new URL("../../migrations/0006_conversation_chat_mode.sql", import.meta.url));
const conversationKeyMigrationFile = fileURLToPath(new URL("../../migrations/0007_conversation_keys.sql", import.meta.url));
const threadsSummaryMigrationFile = fileURLToPath(new URL("../../migrations/0008_threads_summary.sql", import.meta.url));
const threadRolloutStateMigrationFile = fileURLToPath(new URL("../../migrations/0009_thread_rollout.sql", import.meta.url));
const larkMessageEventDedupeMigrationFile = fileURLToPath(new URL("../../migrations/0010_lark_message_event_dedupe.sql", import.meta.url));
const removeProjectConversationTypeMigrationFile = fileURLToPath(new URL("../../migrations/0011_remove_project_conversation_type.sql", import.meta.url));
const threadPlanStatusMigrationFile = fileURLToPath(new URL("../../migrations/0012_thread_plan_status.sql", import.meta.url));

export function loadStoreMigrations(): StoreMigration[] {
  return [
    {
      version: 1,
      name: "0001_initial",
      sql: fs.readFileSync(initialMigrationFile, "utf8")
    },
    {
      version: 2,
      name: "0002_codex_thread_rollout",
      sql: fs.readFileSync(threadRolloutMigrationFile, "utf8")
    },
    {
      version: 3,
      name: "0003_runtime_history",
      sql: fs.readFileSync(runtimeHistoryMigrationFile, "utf8")
    },
    {
      version: 4,
      name: "0004_group_conversations",
      sql: fs.readFileSync(groupConversationsMigrationFile, "utf8")
    },
    {
      version: 5,
      name: "0005_card_actions",
      sql: fs.readFileSync(cardActionsMigrationFile, "utf8")
    },
    {
      version: 6,
      name: "0006_conversation_chat_mode",
      sql: fs.readFileSync(conversationChatModeMigrationFile, "utf8")
    },
    {
      version: 7,
      name: "0007_conversation_keys",
      sql: fs.readFileSync(conversationKeyMigrationFile, "utf8")
    },
    {
      version: 8,
      name: "0008_threads_summary",
      sql: fs.readFileSync(threadsSummaryMigrationFile, "utf8")
    },
    {
      version: 9,
      name: "0009_thread_rollout",
      sql: fs.readFileSync(threadRolloutStateMigrationFile, "utf8")
    },
    {
      version: 10,
      name: "0010_lark_message_event_dedupe",
      sql: fs.readFileSync(larkMessageEventDedupeMigrationFile, "utf8")
    },
    {
      version: 11,
      name: "0011_remove_project_conversation_type",
      sql: fs.readFileSync(removeProjectConversationTypeMigrationFile, "utf8")
    },
    {
      version: 12,
      name: "0012_thread_plan_status",
      sql: fs.readFileSync(threadPlanStatusMigrationFile, "utf8")
    }
  ];
}

export function getStoreSchemaVersion(db: Database.Database): number {
  const version = db.pragma("user_version", { simple: true });
  if (typeof version !== "number") {
    throw new TwinnyError("SQLite PRAGMA user_version returned a non-numeric value", "STORE_INVALID_VERSION");
  }
  return version;
}

export function runStoreMigrations(db: Database.Database, options: RunMigrationsOptions = {}): number {
  const migrations = [...(options.migrations ?? loadStoreMigrations())].sort((left, right) => left.version - right.version);
  const targetVersion = migrations.at(-1)?.version ?? 0;
  const currentVersion = getStoreSchemaVersion(db);

  if (currentVersion > targetVersion) {
    throw new TwinnyError(
      `SQLite schema version ${currentVersion} is newer than supported version ${targetVersion}`,
      "STORE_UNSUPPORTED_VERSION"
    );
  }

  const pending = migrations.filter((migration) => migration.version > currentVersion);
  if (currentVersion >= 8) {
    ensureThreadsSummarySchemaConsistency(db);
  }
  const migrate = db.transaction(() => {
    let lastVersion = currentVersion;
    if (pending.length === 0) {
      return lastVersion;
    }

    for (const migration of pending) {
      if (migration.version !== lastVersion + 1) {
        throw new TwinnyError(
          `SQLite migration ${migration.name} is not contiguous after version ${lastVersion}`,
          "STORE_MIGRATION_GAP"
        );
      }
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
      lastVersion = migration.version;
    }
    return lastVersion;
  });

  const appliedVersion = migrate();
  if (appliedVersion >= 8) {
    ensureThreadsSummarySchemaConsistency(db);
  }
  return appliedVersion;
}

type SqliteColumn = {
  name: string;
};

function getTableColumns(db: Database.Database, tableName: string): Set<string> {
  const rows = db.prepare<[], SqliteColumn>(`PRAGMA table_info(${tableName})`).all();
  return new Set(rows.map((row) => row.name));
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db.prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName) !== undefined
  );
}

function ensureTableColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
  columnDefinition: string
): void {
  const columns = getTableColumns(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
  }
}

function ensureThreadsSummarySchemaConsistency(db: Database.Database): void {
  const hasConversationsTable = tableExists(db, "conversations");
  if (!hasConversationsTable) {
    return;
  }

  const hasThreadsTable = tableExists(db, "threads");
  const hasCodexThreadsTable = tableExists(db, "codex_threads");
  if (!hasThreadsTable && !hasCodexThreadsTable) {
    return;
  }
  let threadsTable = hasThreadsTable ? "threads" : "codex_threads";

  if (!hasThreadsTable && hasCodexThreadsTable) {
    db.exec("ALTER TABLE codex_threads RENAME TO threads");
    threadsTable = "threads";
  }

  const conversationColumns = getTableColumns(db, "conversations");
  const threadsColumns = getTableColumns(db, threadsTable);
  const larkMessagesColumns = tableExists(db, "lark_messages") ? getTableColumns(db, "lark_messages") : new Set<string>();

  if (conversationColumns.has("codex_thread_id") && !conversationColumns.has("thread_id")) {
    db.exec("ALTER TABLE conversations RENAME COLUMN codex_thread_id TO thread_id");
    db.exec("ALTER TABLE conversations RENAME COLUMN codex_thread_has_rollout TO thread_has_rollout");
  }

  if (threadsColumns.has("codex_thread_id") && !threadsColumns.has("thread_id")) {
    db.exec(`ALTER TABLE ${threadsTable} RENAME COLUMN codex_thread_id TO thread_id`);
  }

  if (threadsColumns.has("forked_from_codex_thread_id") && !threadsColumns.has("forked_from_thread_id")) {
    db.exec(`ALTER TABLE ${threadsTable} RENAME COLUMN forked_from_codex_thread_id TO forked_from_thread_id`);
  }

  if (larkMessagesColumns.has("codex_thread_id") && !larkMessagesColumns.has("thread_id")) {
    db.exec("ALTER TABLE lark_messages RENAME COLUMN codex_thread_id TO thread_id");
  }

  ensureTableColumn(db, threadsTable, "creator_open_id", "creator_open_id TEXT");
  ensureTableColumn(db, threadsTable, "card_message_id", "card_message_id TEXT");
  ensureTableColumn(db, threadsTable, "input_tokens", "input_tokens INTEGER NOT NULL DEFAULT 0");
  ensureTableColumn(db, threadsTable, "output_tokens", "output_tokens INTEGER NOT NULL DEFAULT 0");
  ensureTableColumn(db, threadsTable, "cached_input_tokens", "cached_input_tokens INTEGER NOT NULL DEFAULT 0");
  ensureTableColumn(db, threadsTable, "reasoning_output_tokens", "reasoning_output_tokens INTEGER NOT NULL DEFAULT 0");
  ensureTableColumn(db, threadsTable, "context_tokens", "context_tokens INTEGER NOT NULL DEFAULT 0");
  ensureTableColumn(db, threadsTable, "context_window", "context_window INTEGER NOT NULL DEFAULT 0");

  db.exec("DROP INDEX IF EXISTS idx_codex_threads_conversation_lark_thread");
  db.exec("DROP INDEX IF EXISTS idx_conversations_codex_thread_id");
  db.exec("DROP INDEX IF EXISTS idx_lark_messages_codex_thread_turn");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_conversation_lark_thread ON threads(conversation_key, lark_thread_id) WHERE lark_thread_id IS NOT NULL"
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_thread_id ON conversations(thread_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_lark_messages_thread_turn ON lark_messages(thread_id, codex_turn_id)");
}
