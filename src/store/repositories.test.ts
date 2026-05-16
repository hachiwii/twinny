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
      codexThreadHasRollout: true,
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

  it("updates thread bindings transactionally", () => {
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
      codexThreadId: "thread-new",
      codexThreadHasRollout: false
    });

    expect(updated.codexThreadId).toBe("thread-new");
    expect(updated.codexThreadHasRollout).toBe(false);
    expect(updated.updatedAt).toBe(2000);
    expect(updated.workspace).toBe(workspace);
    expect(updated.roleCodexHome).toBe(roleCodexHome);

    now = 3000;
    repo.markThreadHasRollout("p2p:ou_456", "thread-new");
    expect(repo.getByConversationKey("p2p:ou_456")).toMatchObject({
      codexThreadId: "thread-new",
      codexThreadHasRollout: true,
      updatedAt: 3000
    });

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(["codex_threads", "conversations", "lark_messages", "users"]);
  });

  it("records runtime users, codex threads, messages, and token usage by business ids", () => {
    const repo = createConversationRepository(db, { now: () => now });
    const workspace = path.join(tempDir, "workspaces", "p2p:ou_456");
    const roleCodexHome = path.join(tempDir, "roles", "guest", "codex");

    repo.create({
      conversationKey: "p2p:ou_456",
      type: "p2p",
      chatId: "ou_456",
      name: "Guest User",
      role: "guest",
      codexThreadId: "thread-1",
      workspace,
      roleCodexHome
    });

    now = 1100;
    const user = repo.upsertUser({ larkUserId: "ou_456", role: "guest", seenAt: 1001 });
    expect(user).toMatchObject({
      id: 1,
      larkUserId: "ou_456",
      name: "",
      role: "guest",
      createdAt: 1100,
      updatedAt: 1100,
      lastSeenAt: 1001
    });

    now = 1200;
    const thread = repo.upsertCodexThread({
      codexThreadId: "thread-1",
      conversationKey: "p2p:ou_456",
      role: "guest"
    });
    expect(thread).toMatchObject({
      id: 1,
      codexThreadId: "thread-1",
      conversationKey: "p2p:ou_456",
      role: "guest",
      totalTokens: 0,
      tokenUsageJson: "{}"
    });

    now = 1300;
    const message = repo.insertLarkMessage({
      larkMessageId: "om_1",
      eventId: "event_1",
      larkUserId: "ou_456",
      conversationKey: "p2p:ou_456",
      routeKind: "queued_message",
      status: "queued",
      text: "hello",
      larkCreateTime: 1001,
      rawEventJson: "{}"
    });
    expect(message).toMatchObject({
      id: 1,
      larkMessageId: "om_1",
      larkUserId: "ou_456",
      conversationKey: "p2p:ou_456",
      routeKind: "queued_message",
      status: "queued",
      text: "hello",
      receivedAt: 1300,
      updatedAt: 1300
    });

    now = 1400;
    repo.markLarkMessagesProcessing(["om_1"], {
      conversationKey: "p2p:ou_456",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1"
    });
    expect(repo.getLarkMessageById("om_1")).toMatchObject({
      status: "processing",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      processingStartedAt: 1400,
      updatedAt: 1400
    });

    now = 1500;
    repo.markLarkMessagesCompleted(["om_1"]);
    expect(repo.getLarkMessageById("om_1")).toMatchObject({
      status: "completed",
      completedAt: 1500,
      updatedAt: 1500
    });

    repo.insertLarkMessage({
      larkMessageId: "om_2",
      eventId: "event_2",
      larkUserId: "ou_456",
      conversationKey: "p2p:ou_456",
      routeKind: "message",
      status: "processing",
      text: "processing",
      rawEventJson: "{}"
    });
    repo.insertLarkMessage({
      larkMessageId: "om_3",
      eventId: "event_3",
      larkUserId: "ou_456",
      conversationKey: "p2p:ou_456",
      routeKind: "queued_message",
      status: "queued",
      text: "queued",
      rawEventJson: "{}"
    });
    expect(repo.listUnfinishedLarkMessages().map((row) => row.larkMessageId)).toEqual(["om_2", "om_3"]);

    now = 1600;
    repo.updateCodexThreadTokenUsage({
      codexThreadId: "thread-1",
      conversationKey: "p2p:ou_456",
      role: "guest",
      totalTokens: 123,
      tokenUsageJson: '{"totalTokens":123}'
    });
    expect(repo.getCodexThreadById("thread-1")).toMatchObject({
      codexThreadId: "thread-1",
      totalTokens: 123,
      tokenUsageJson: '{"totalTokens":123}',
      updatedAt: 1600
    });
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
