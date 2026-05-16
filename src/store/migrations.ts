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

export const currentStoreSchemaVersion = 3;

const initialMigrationFile = fileURLToPath(new URL("../../migrations/0001_initial.sql", import.meta.url));
const threadRolloutMigrationFile = fileURLToPath(new URL("../../migrations/0002_codex_thread_rollout.sql", import.meta.url));
const runtimeHistoryMigrationFile = fileURLToPath(new URL("../../migrations/0003_runtime_history.sql", import.meta.url));

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
  if (pending.length === 0) {
    return currentVersion;
  }

  const migrate = db.transaction(() => {
    let lastVersion = currentVersion;
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

  return migrate();
}
