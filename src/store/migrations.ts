import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { TwinnyError } from "../errors.js";
import type { TwinnyDatabase } from "./db.js";

export interface StoreMigration {
  version: number;
  name: string;
  sql: string;
}

export interface RunMigrationsOptions {
  migrations?: StoreMigration[];
}

export const currentStoreSchemaVersion = 9;

const baselineMigrationFile = fileURLToPath(new URL("../../migrations/0001_initial.sql", import.meta.url));
const larkDocWatcherMigrationFile = fileURLToPath(new URL("../../migrations/0002_lark_doc_watcher.sql", import.meta.url));
const larkMessageDocCommentIdMigrationFile = fileURLToPath(new URL("../../migrations/0003_lark_message_doc_comment_id.sql", import.meta.url));
const threadWorkspaceMigrationFile = fileURLToPath(new URL("../../migrations/0004_thread_workspace.sql", import.meta.url));
const threadCreateMethodMigrationFile = fileURLToPath(new URL("../../migrations/0005_thread_create_method.sql", import.meta.url));
const cronJobsMigrationFile = fileURLToPath(new URL("../../migrations/0006_cron_jobs.sql", import.meta.url));
const threadForkBaseTokenUsageMigrationFile = fileURLToPath(new URL("../../migrations/0007_thread_fork_base_token_usage.sql", import.meta.url));
const larkDocWatcherRemoveNoneMigrationFile = fileURLToPath(new URL("../../migrations/0008_lark_doc_watcher_remove_none.sql", import.meta.url));
const larkDocWatcherFourModesMigrationFile = fileURLToPath(new URL("../../migrations/0009_lark_doc_watcher_four_modes.sql", import.meta.url));

export function loadStoreMigrations(): StoreMigration[] {
  return [
    {
      version: 1,
      name: "0001_initial",
      sql: fs.readFileSync(baselineMigrationFile, "utf8")
    },
    {
      version: 2,
      name: "0002_lark_doc_watcher",
      sql: fs.readFileSync(larkDocWatcherMigrationFile, "utf8")
    },
    {
      version: 3,
      name: "0003_lark_message_doc_comment_id",
      sql: fs.readFileSync(larkMessageDocCommentIdMigrationFile, "utf8")
    },
    {
      version: 4,
      name: "0004_thread_workspace",
      sql: fs.readFileSync(threadWorkspaceMigrationFile, "utf8")
    },
    {
      version: 5,
      name: "0005_thread_create_method",
      sql: fs.readFileSync(threadCreateMethodMigrationFile, "utf8")
    },
    {
      version: 6,
      name: "0006_cron_jobs",
      sql: fs.readFileSync(cronJobsMigrationFile, "utf8")
    },
    {
      version: 7,
      name: "0007_thread_fork_base_token_usage",
      sql: fs.readFileSync(threadForkBaseTokenUsageMigrationFile, "utf8")
    },
    {
      version: 8,
      name: "0008_lark_doc_watcher_remove_none",
      sql: fs.readFileSync(larkDocWatcherRemoveNoneMigrationFile, "utf8")
    },
    {
      version: 9,
      name: "0009_lark_doc_watcher_four_modes",
      sql: fs.readFileSync(larkDocWatcherFourModesMigrationFile, "utf8")
    }
  ];
}

export function getStoreSchemaVersion(db: TwinnyDatabase): number {
  const version = db.pragma("user_version", { simple: true });
  if (typeof version !== "number") {
    throw new TwinnyError("SQLite PRAGMA user_version returned a non-numeric value", "STORE_INVALID_VERSION");
  }
  return version;
}

export function runStoreMigrations(db: TwinnyDatabase, options: RunMigrationsOptions = {}): number {
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
  validateSchemaBeforeMigration(db, currentVersion);
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
  if (appliedVersion >= currentStoreSchemaVersion) {
    validateBaselineSchema(db);
  }
  return appliedVersion;
}

type SqliteColumn = {
  name: string;
};

function validateSchemaBeforeMigration(db: TwinnyDatabase, currentVersion: number): void {
  if (currentVersion <= 0) {
    return;
  }

  const requiredColumnsByTable = new Map<string, string[]>([
    [
      "conversations",
      ["conversation_key", "type", "chat_id", "name", "profile", "thread_id", "workspace", "profile_codex_home", "response_mode"]
    ],
    [
      "threads",
      ["thread_id", "conversation_key", "profile", "thread_has_rollout", "mode", "status", "name", "goal_status", "model", "effort"]
    ],
    [
      "lark_messages",
      ["event_id", "lark_user_id", "conversation_key", "thread_id", "route_kind", "status", "side_id", "token_usage_json"]
    ]
  ]);

  if (currentVersion >= 2) {
    requiredColumnsByTable.set("lark_doc_watcher", [
      "file_type",
      "file_token",
      "thread_id",
      "watch_mode",
      "watch_url",
      "last_comment_received_at"
    ]);
  }
  if (currentVersion >= 5) {
    requiredColumnsByTable.set("threads", [
      "thread_id",
      "conversation_key",
      "profile",
      "thread_has_rollout",
      "mode",
      "status",
      "name",
      "goal_status",
      "model",
      "effort",
      "workspace",
      "parent_thread",
      "create_method",
      "create_request_text"
    ]);
    requiredColumnsByTable.set("lark_messages", [
      "event_id",
      "lark_user_id",
      "doc_comment_id",
      "conversation_key",
      "thread_id",
      "route_kind",
      "status",
      "token_usage_json"
    ]);
  } else if (currentVersion >= 4) {
    requiredColumnsByTable.set("threads", [
      "thread_id",
      "conversation_key",
      "profile",
      "thread_has_rollout",
      "mode",
      "status",
      "name",
      "goal_status",
      "model",
      "effort",
      "workspace",
      "fork_source"
    ]);
    requiredColumnsByTable.set("lark_messages", [
      "event_id",
      "lark_user_id",
      "doc_comment_id",
      "conversation_key",
      "thread_id",
      "route_kind",
      "status",
      "token_usage_json"
    ]);
  }
  if (currentVersion >= 7) {
    requiredColumnsByTable.set("threads", [
      "thread_id",
      "conversation_key",
      "profile",
      "thread_has_rollout",
      "mode",
      "status",
      "name",
      "goal_status",
      "model",
      "effort",
      "workspace",
      "parent_thread",
      "create_method",
      "create_request_text",
      "fork_base_token_usage_json"
    ]);
  }

  validateRequiredColumns(db, requiredColumnsByTable);
}

function validateBaselineSchema(db: TwinnyDatabase): void {
  const requiredColumnsByTable = new Map<string, string[]>([
    [
      "conversations",
      ["conversation_key", "type", "chat_id", "name", "profile", "thread_id", "workspace", "profile_codex_home", "response_mode"]
    ],
    [
      "threads",
      [
        "thread_id",
        "conversation_key",
        "profile",
        "thread_has_rollout",
        "mode",
        "status",
        "name",
        "goal_status",
        "model",
        "effort",
        "workspace",
        "parent_thread",
        "create_method",
        "create_request_text",
        "fork_base_token_usage_json"
      ]
    ],
    [
      "lark_messages",
      ["event_id", "lark_user_id", "doc_comment_id", "conversation_key", "thread_id", "route_kind", "status", "token_usage_json"]
    ],
    [
      "lark_doc_watcher",
      ["file_type", "file_token", "thread_id", "watch_mode", "watch_url", "last_comment_received_at"]
    ],
    [
      "cron_jobs",
      [
        "conversation_key",
        "thread_id",
        "cron_expression",
        "message_text",
        "timezone",
        "last_run_at",
        "last_lark_message_id",
        "created_by_open_id"
      ]
    ]
  ]);

  validateRequiredColumns(db, requiredColumnsByTable);
}

function validateRequiredColumns(db: TwinnyDatabase, requiredColumnsByTable: Map<string, string[]>): void {
  for (const [tableName, requiredColumns] of requiredColumnsByTable) {
    const columns = getTableColumns(db, tableName);
    for (const columnName of requiredColumns) {
      if (!columns.has(columnName)) {
        throw new TwinnyError(
          `SQLite schema does not match the 1.0 baseline; reset or manually migrate the pre-1.0 development database before continuing`,
          "STORE_BASELINE_MISMATCH"
        );
      }
    }
  }
}

function getTableColumns(db: TwinnyDatabase, tableName: string): Set<string> {
  const rows = db.prepare<[], SqliteColumn>(`PRAGMA table_info(${tableName})`).all();
  return new Set(rows.map((row) => row.name));
}
