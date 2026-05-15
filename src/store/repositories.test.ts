import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TwinnyDatabase } from "./db.js";
import { openTwinnyDatabase } from "./db.js";
import { createConversationRepository } from "./repositories.js";

describe("ConversationRepository", () => {
  let tempDir: string;
  let db: TwinnyDatabase;
  let now = 1000;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-store-"));
    db = openTwinnyDatabase(path.join(tempDir, "sqlite", "twinny.db"));
    now = 1000;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates and queries the P2P conversation mapping", () => {
    const repo = createConversationRepository(db, { now: () => now });
    const workspace = path.join(tempDir, "workspaces", "p2p:ou_123");
    const roleCodexHome = path.join(tempDir, "roles", "guest", "codex");

    const created = repo.create({
      conversationKey: "p2p:ou_123",
      type: "p2p",
      chatId: "ou_123",
      name: "Guest User",
      role: "guest",
      codexThreadId: "thread-1",
      workspace,
      roleCodexHome
    });

    expect(created).toMatchObject({
      id: 1,
      conversationKey: "p2p:ou_123",
      type: "p2p",
      chatId: "ou_123",
      name: "Guest User",
      role: "guest",
      codexThreadId: "thread-1",
      workspace,
      roleCodexHome,
      createdAt: 1000,
      updatedAt: 1000
    });
    expect(repo.getByConversationKey("p2p:ou_123")).toEqual(created);
    expect(repo.getByTypeAndChatId("p2p", "ou_123")).toEqual(created);
    expect(repo.getByCodexThreadId("thread-1")).toEqual(created);
    expect(repo.list()).toEqual([created]);
  });

  it("updates thread bindings transactionally without adding runtime event tables", () => {
    const repo = createConversationRepository(db, { now: () => now });
    const workspace = path.join(tempDir, "workspaces", "p2p:ou_456");
    const roleCodexHome = path.join(tempDir, "roles", "owner", "codex");

    repo.create({
      conversationKey: "p2p:ou_456",
      type: "p2p",
      chatId: "ou_456",
      name: "Owner User",
      role: "owner",
      codexThreadId: "thread-old",
      workspace,
      roleCodexHome
    });

    now = 2000;
    const updated = repo.updateThreadBinding("p2p:ou_456", {
      codexThreadId: "thread-new"
    });

    expect(updated.codexThreadId).toBe("thread-new");
    expect(updated.updatedAt).toBe(2000);
    expect(updated.workspace).toBe(workspace);
    expect(updated.roleCodexHome).toBe(roleCodexHome);

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(["conversations"]);
  });

  it("rejects mismatched or unsafe conversation keys", () => {
    const repo = createConversationRepository(db);
    const workspace = path.join(tempDir, "workspaces", "p2p:ou_789");
    const roleCodexHome = path.join(tempDir, "roles", "guest", "codex");

    expect(() =>
      repo.create({
        conversationKey: "p2p:ou_other",
        type: "p2p",
        chatId: "ou_789",
        name: "Guest User",
        role: "guest",
        codexThreadId: "thread-1",
        workspace,
        roleCodexHome
      })
    ).toThrow(/must be p2p:ou_789/);

    expect(() =>
      repo.create({
        conversationKey: "p2p:../secret",
        type: "p2p",
        chatId: "../secret",
        name: "Guest User",
        role: "guest",
        codexThreadId: "thread-1",
        workspace,
        roleCodexHome
      })
    ).toThrow();
  });
});
