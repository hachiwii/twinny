import path from "node:path";

import type Database from "better-sqlite3";

import { TwinnyError } from "../errors.js";
import type { ConversationRecord, ConversationType, NewConversationRecord, RoleName } from "../types.js";
import { assertValidConversationKey, createP2PConversationKey } from "../workspace/slug.js";

interface ConversationRow {
  id: number;
  conversation_key: string;
  type: ConversationType;
  chat_id: string;
  name: string;
  role: RoleName;
  codex_thread_id: string;
  codex_thread_has_rollout: 0 | 1;
  workspace: string;
  role_codex_home: string;
  created_at: number;
  updated_at: number;
}

interface InsertConversationParams {
  conversationKey: string;
  type: ConversationType;
  chatId: string;
  name: string;
  role: RoleName;
  codexThreadId: string;
  codexThreadHasRollout: 0 | 1;
  workspace: string;
  roleCodexHome: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateConversationThreadBinding {
  codexThreadId: string;
  codexThreadHasRollout?: boolean;
  role?: RoleName;
  roleCodexHome?: string;
  workspace?: string;
}

export interface ConversationRepositoryOptions {
  now?: () => number;
}

export class ConversationRepository {
  private readonly now: () => number;

  private readonly insertConversation: Database.Statement<[InsertConversationParams]>;
  private readonly selectByConversationKey: Database.Statement<[string], ConversationRow>;
  private readonly selectByTypeAndChatId: Database.Statement<[ConversationType, string], ConversationRow>;
  private readonly selectByCodexThreadId: Database.Statement<[string], ConversationRow>;
  private readonly selectAll: Database.Statement<[], ConversationRow>;
  private readonly updateThread: Database.Statement<[
    string,
    0 | 1,
    RoleName,
    string,
    string,
    number,
    string
  ]>;
  private readonly markRollout: Database.Statement<[number, string, string]>;
  private readonly deleteByKey: Database.Statement<[string]>;

  constructor(
    private readonly db: Database.Database,
    options: ConversationRepositoryOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.insertConversation = this.db.prepare(`
      INSERT INTO conversations (
        conversation_key,
        type,
        chat_id,
        name,
        role,
        codex_thread_id,
        codex_thread_has_rollout,
        workspace,
        role_codex_home,
        created_at,
        updated_at
      ) VALUES (
        @conversationKey,
        @type,
        @chatId,
        @name,
        @role,
        @codexThreadId,
        @codexThreadHasRollout,
        @workspace,
        @roleCodexHome,
        @createdAt,
        @updatedAt
      )
    `);
    this.selectByConversationKey = this.db.prepare(`
      SELECT * FROM conversations WHERE conversation_key = ?
    `);
    this.selectByTypeAndChatId = this.db.prepare(`
      SELECT * FROM conversations WHERE type = ? AND chat_id = ?
    `);
    this.selectByCodexThreadId = this.db.prepare(`
      SELECT * FROM conversations WHERE codex_thread_id = ?
    `);
    this.selectAll = this.db.prepare(`
      SELECT * FROM conversations ORDER BY id ASC
    `);
    this.updateThread = this.db.prepare(`
      UPDATE conversations
      SET codex_thread_id = ?,
          codex_thread_has_rollout = ?,
          role = ?,
          role_codex_home = ?,
          workspace = ?,
          updated_at = ?
      WHERE conversation_key = ?
    `);
    this.markRollout = this.db.prepare(`
      UPDATE conversations
      SET codex_thread_has_rollout = 1,
          updated_at = ?
      WHERE conversation_key = ?
        AND codex_thread_id = ?
    `);
    this.deleteByKey = this.db.prepare(`
      DELETE FROM conversations WHERE conversation_key = ?
    `);
  }

  create(input: NewConversationRecord): ConversationRecord {
    const params = this.toInsertParams(input);
    const create = this.db.transaction(() => {
      this.insertConversation.run(params);
      return this.requireByConversationKey(params.conversationKey);
    });
    return create();
  }

  getOrCreate(input: NewConversationRecord): ConversationRecord {
    const params = this.toInsertParams(input);
    const getOrCreate = this.db.transaction(() => {
      const existing = this.getByConversationKey(params.conversationKey);
      if (existing) {
        return existing;
      }
      this.insertConversation.run(params);
      return this.requireByConversationKey(params.conversationKey);
    });
    return getOrCreate();
  }

  getByConversationKey(conversationKey: string): ConversationRecord | undefined {
    assertValidConversationKey(conversationKey);
    return mapConversationRow(this.selectByConversationKey.get(conversationKey));
  }

  getByTypeAndChatId(type: ConversationType, chatId: string): ConversationRecord | undefined {
    assertValidConversationType(type);
    assertExpectedP2PConversationKey(createP2PConversationKey(chatId), type, chatId);
    return mapConversationRow(this.selectByTypeAndChatId.get(type, chatId));
  }

  getByCodexThreadId(codexThreadId: string): ConversationRecord | undefined {
    assertNonEmpty(codexThreadId, "codexThreadId");
    return mapConversationRow(this.selectByCodexThreadId.get(codexThreadId));
  }

  list(): ConversationRecord[] {
    return this.selectAll.all().map((row) => mapRequiredConversationRow(row));
  }

  updateThreadBinding(conversationKey: string, update: UpdateConversationThreadBinding): ConversationRecord {
    assertValidConversationKey(conversationKey);
    assertNonEmpty(update.codexThreadId, "codexThreadId");
    if (update.role !== undefined) {
      assertValidRole(update.role);
    }
    if (update.roleCodexHome !== undefined) {
      assertNonEmpty(update.roleCodexHome, "roleCodexHome");
    }
    if (update.workspace !== undefined) {
      assertAbsolutePath(update.workspace, "workspace");
    }

    const updateBinding = this.db.transaction(() => {
      const existing = this.requireByConversationKey(conversationKey);
      const role = update.role ?? existing.role;
      const roleCodexHome = update.roleCodexHome ?? existing.roleCodexHome;
      const workspace = update.workspace ?? existing.workspace;
      const codexThreadHasRollout = update.codexThreadHasRollout ?? existing.codexThreadHasRollout;
      this.updateThread.run(
        update.codexThreadId,
        codexThreadHasRollout ? 1 : 0,
        role,
        roleCodexHome,
        workspace,
        this.now(),
        conversationKey
      );
      return this.requireByConversationKey(conversationKey);
    });

    return updateBinding();
  }

  markThreadHasRollout(conversationKey: string, codexThreadId: string): void {
    assertValidConversationKey(conversationKey);
    assertNonEmpty(codexThreadId, "codexThreadId");
    this.markRollout.run(this.now(), conversationKey, codexThreadId);
  }

  deleteByConversationKey(conversationKey: string): boolean {
    assertValidConversationKey(conversationKey);
    const remove = this.db.transaction(() => this.deleteByKey.run(conversationKey).changes > 0);
    return remove();
  }

  private requireByConversationKey(conversationKey: string): ConversationRecord {
    const record = this.getByConversationKey(conversationKey);
    if (!record) {
      throw new TwinnyError(`Conversation ${conversationKey} was not found`, "CONVERSATION_NOT_FOUND");
    }
    return record;
  }

  private toInsertParams(input: NewConversationRecord): InsertConversationParams {
    validateNewConversation(input);
    const now = this.now();
    return {
      conversationKey: input.conversationKey,
      type: input.type,
      chatId: input.chatId,
      name: input.name,
      role: input.role,
      codexThreadId: input.codexThreadId,
      codexThreadHasRollout: input.codexThreadHasRollout === false ? 0 : 1,
      workspace: input.workspace,
      roleCodexHome: input.roleCodexHome,
      createdAt: now,
      updatedAt: now
    };
  }
}

export function createConversationRepository(
  db: Database.Database,
  options: ConversationRepositoryOptions = {}
): ConversationRepository {
  return new ConversationRepository(db, options);
}

function mapConversationRow(row: ConversationRow | undefined): ConversationRecord | undefined {
  if (!row) {
    return undefined;
  }

  return mapRequiredConversationRow(row);
}

function mapRequiredConversationRow(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    conversationKey: row.conversation_key,
    type: row.type,
    chatId: row.chat_id,
    name: row.name,
    role: row.role,
    codexThreadId: row.codex_thread_id,
    codexThreadHasRollout: row.codex_thread_has_rollout === 1,
    workspace: row.workspace,
    roleCodexHome: row.role_codex_home,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validateNewConversation(input: NewConversationRecord): void {
  assertExpectedP2PConversationKey(input.conversationKey, input.type, input.chatId);
  assertNonEmpty(input.name, "name");
  assertValidRole(input.role);
  assertNonEmpty(input.codexThreadId, "codexThreadId");
  assertAbsolutePath(input.workspace, "workspace");
  assertNonEmpty(input.roleCodexHome, "roleCodexHome");
}

function assertExpectedP2PConversationKey(conversationKey: string, type: ConversationType, chatId: string): void {
  assertValidConversationType(type);
  const expectedKey = createP2PConversationKey(chatId);
  if (conversationKey !== expectedKey) {
    throw new TwinnyError(
      `P2P conversation key must be ${expectedKey}, received ${conversationKey}`,
      "CONVERSATION_KEY_MISMATCH"
    );
  }
}

function assertValidConversationType(type: ConversationType): void {
  if (type !== "p2p") {
    throw new TwinnyError(`Unsupported conversation type: ${type}`, "CONVERSATION_TYPE_INVALID");
  }
}

function assertValidRole(role: RoleName): void {
  if (role !== "owner" && role !== "guest") {
    throw new TwinnyError(`Unsupported role: ${role}`, "CONVERSATION_ROLE_INVALID");
  }
}

function assertAbsolutePath(value: string, field: string): void {
  assertNonEmpty(value, field);
  if (!path.isAbsolute(value)) {
    throw new TwinnyError(`${field} must be an absolute path`, "CONVERSATION_PATH_INVALID");
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new TwinnyError(`${field} must not be empty`, "CONVERSATION_FIELD_EMPTY");
  }
}
