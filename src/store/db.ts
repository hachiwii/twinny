import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { RuntimePaths } from "../types.js";
import { runStoreMigrations } from "./migrations.js";

export type TwinnyDatabase = InstanceType<typeof Database>;

export interface OpenTwinnyDatabaseOptions {
  migrate?: boolean;
  readonly?: boolean;
  timeoutMs?: number;
}

export function openTwinnyDatabase(sqliteFile: string, options: OpenTwinnyDatabaseOptions = {}): TwinnyDatabase {
  if (!options.readonly) {
    fs.mkdirSync(path.dirname(sqliteFile), { recursive: true });
  }

  const databaseOptions: Database.Options = {};
  if (options.readonly !== undefined) {
    databaseOptions.readonly = options.readonly;
  }
  if (options.timeoutMs !== undefined) {
    databaseOptions.timeout = options.timeoutMs;
  }

  const db = new Database(sqliteFile, databaseOptions);

  db.pragma("foreign_keys = ON");

  if (!options.readonly) {
    db.pragma("journal_mode = WAL");
    if (options.migrate ?? true) {
      runStoreMigrations(db);
    }
  }

  return db;
}

export function openRuntimeDatabase(paths: Pick<RuntimePaths, "sqliteFile">, options: OpenTwinnyDatabaseOptions = {}): TwinnyDatabase {
  return openTwinnyDatabase(paths.sqliteFile, options);
}
