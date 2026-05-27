import fs from "node:fs";
import path from "node:path";

import { DatabaseSync, type DatabaseSyncOptions, type StatementSync } from "node:sqlite";

import type { RuntimePaths } from "../types.js";
import { runStoreMigrations } from "./migrations.js";

type SqliteInputValue = null | number | bigint | string | ArrayBufferView;
type SqliteOutputValue = null | number | bigint | string | NodeJS.NonSharedUint8Array;
type NativeBindParameter = SqliteInputValue | Record<string, SqliteInputValue>;

export interface TwinnyStatementResult {
  changes: number;
  lastInsertRowid: number;
}

export interface TwinnyStatement<Params extends unknown[] = unknown[], Row = Record<string, SqliteOutputValue>> {
  run(...params: Params): TwinnyStatementResult;
  get(...params: Params): Row | undefined;
  all(...params: Params): Row[];
}

export class TwinnyDatabase {
  private readonly db: DatabaseSync;
  private savepointId = 0;

  constructor(sqliteFile: string, options: DatabaseSyncOptions = {}) {
    this.db = new DatabaseSync(sqliteFile, options);
  }

  prepare<Params extends unknown[] = unknown[], Row = Record<string, SqliteOutputValue>>(
    sql: string
  ): TwinnyStatement<Params, Row> {
    return new NodeSqliteStatement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string, options: { simple: true }): SqliteOutputValue | undefined;
  pragma(sql: string, options?: { simple?: false }): Record<string, SqliteOutputValue>[];
  pragma(sql: string, options: { simple?: boolean } = {}): SqliteOutputValue | Record<string, SqliteOutputValue>[] | undefined {
    const rows = this.prepare<[], Record<string, SqliteOutputValue>>(`PRAGMA ${sql}`).all();
    if (!options.simple) {
      return rows;
    }

    const firstRow = rows[0];
    if (!firstRow) {
      return undefined;
    }
    return Object.values(firstRow)[0];
  }

  transaction<Params extends unknown[], Result>(fn: (...params: Params) => Result): (...params: Params) => Result {
    return (...params: Params) => {
      if (this.db.isTransaction) {
        return this.runInSavepoint(fn, params);
      }

      this.db.exec("BEGIN");
      try {
        const result = fn(...params);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.rollback("ROLLBACK");
        throw error;
      }
    };
  }

  close(): void {
    this.db.close();
  }

  private runInSavepoint<Params extends unknown[], Result>(fn: (...params: Params) => Result, params: Params): Result {
    const savepointName = `twinny_tx_${++this.savepointId}`;
    this.db.exec(`SAVEPOINT ${savepointName}`);
    try {
      const result = fn(...params);
      this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      this.rollback(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      this.rollback(`RELEASE SAVEPOINT ${savepointName}`);
      throw error;
    }
  }

  private rollback(sql: string): void {
    try {
      this.db.exec(sql);
    } catch {
      // Preserve the original failure; rollback errors are secondary here.
    }
  }
}

class NodeSqliteStatement<Params extends unknown[] = unknown[], Row = Record<string, SqliteOutputValue>>
  implements TwinnyStatement<Params, Row>
{
  constructor(private readonly statement: StatementSync) {}

  run(...params: Params): TwinnyStatementResult {
    const run = this.statement.run as (...parameters: NativeBindParameter[]) => {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
    const result = run.apply(this.statement, normalizeParameters(params));
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid)
    };
  }

  get(...params: Params): Row | undefined {
    const get = this.statement.get as (...parameters: NativeBindParameter[]) => Record<string, SqliteOutputValue> | undefined;
    return get.apply(this.statement, normalizeParameters(params)) as Row | undefined;
  }

  all(...params: Params): Row[] {
    const all = this.statement.all as (...parameters: NativeBindParameter[]) => Record<string, SqliteOutputValue>[];
    return all.apply(this.statement, normalizeParameters(params)) as Row[];
  }
}

function normalizeParameters(params: readonly unknown[]): NativeBindParameter[] {
  return params.map((param) => {
    if (isNamedParameterObject(param)) {
      return normalizeNamedParameters(param);
    }
    return normalizeParameterValue(param);
  });
}

function normalizeNamedParameters(parameters: Record<string, unknown>): Record<string, SqliteInputValue> {
  const normalized: Record<string, SqliteInputValue> = {};
  for (const [key, value] of Object.entries(parameters)) {
    normalized[key] = normalizeParameterValue(value);
  }
  return normalized;
}

function normalizeParameterValue(value: unknown): SqliteInputValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new TypeError(`Unsupported SQLite bind parameter type: ${typeof value}`);
}

function isNamedParameterObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer) &&
    Object.getPrototypeOf(value) !== Date.prototype
  );
}

export interface OpenTwinnyDatabaseOptions {
  migrate?: boolean;
  readonly?: boolean;
  timeoutMs?: number;
}

export function openTwinnyDatabase(sqliteFile: string, options: OpenTwinnyDatabaseOptions = {}): TwinnyDatabase {
  if (!options.readonly) {
    fs.mkdirSync(path.dirname(sqliteFile), { recursive: true });
  }

  const databaseOptions: DatabaseSyncOptions = {
    allowBareNamedParameters: true,
    allowUnknownNamedParameters: true,
    enableForeignKeyConstraints: true
  };
  if (options.readonly !== undefined) {
    databaseOptions.readOnly = options.readonly;
  }
  if (options.timeoutMs !== undefined) {
    databaseOptions.timeout = options.timeoutMs;
  }

  const db = new TwinnyDatabase(sqliteFile, databaseOptions);

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
