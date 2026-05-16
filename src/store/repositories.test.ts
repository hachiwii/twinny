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
      responseMode: "all",
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

  it("creates group conversations with response modes and updates group settings", () => {
    const repo = createConversationRepository(db, { now: () => now });
    const workspace = path.join(tempDir, "workspaces", "group:oc_group");
    const roleCodexHome = path.join(tempDir, "roles", "owner", "codex");

    const created = repo.create({
      conversationKey: "group:oc_group",
      type: "topic_group",
      chatId: "oc_group",
      name: "Topic Group",
      chatMode: "topic",
      responseMode: "at",
      role: "owner",
      codexThreadId: "thread-group",
      codexThreadHasRollout: false,
      workspace,
      roleCodexHome
    });

    expect(created).toMatchObject({
      conversationKey: "group:oc_group",
      type: "topic_group",
      chatId: "oc_group",
      name: "Topic Group",
      chatMode: "topic",
      responseMode: "at",
      role: "owner",
      codexThreadHasRollout: false
    });
    expect(repo.getByTypeAndChatId("topic_group", "oc_group")).toEqual(created);

    now = 2000;
    const updated = repo.updateConversationSettings("group:oc_group", {
      name: "Renamed Group",
      chatMode: "group",
      responseMode: "none"
    });
    expect(updated).toMatchObject({
      name: "Renamed Group",
      chatMode: "group",
      responseMode: "none",
      role: "owner",
      updatedAt: 2000
    });
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
    expect(tables).toEqual(["codex_threads", "conversations", "lark_messages"]);
  });

  it("records runtime codex threads, messages, and token usage by business ids", () => {
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

    now = 1350;
    expect(repo.updateQueuedLarkMessage("om_1", { text: "edited", rawEventJson: '{"edited":true}' })).toBe(true);
    expect(repo.getLarkMessageById("om_1")).toMatchObject({
      status: "queued",
      text: "edited",
      rawEventJson: '{"edited":true}',
      updatedAt: 1350
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
    repo.markLarkMessagesSteered(["om_1"], {
      conversationKey: "p2p:ou_456",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1"
    });
    expect(repo.getLarkMessageById("om_1")).toMatchObject({
      status: "steered",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      updatedAt: 1500
    });

    now = 1550;
    repo.markLarkMessagesInterrupted(["om_1"]);
    expect(repo.getLarkMessageById("om_1")).toMatchObject({
      status: "interrupted",
      failedAt: 1550,
      updatedAt: 1550
    });

    repo.insertLarkMessage({
      larkMessageId: "om_recalled",
      eventId: "event_recalled",
      larkUserId: "ou_456",
      conversationKey: "p2p:ou_456",
      routeKind: "queued_message",
      status: "queued",
      text: "recall me",
      rawEventJson: "{}"
    });
    now = 1575;
    expect(repo.markLarkMessageRecalled("om_recalled")).toBe(true);
    expect(repo.getLarkMessageById("om_recalled")).toMatchObject({
      status: "recalled",
      text: "recall me",
      updatedAt: 1575
    });
    expect(repo.updateQueuedLarkMessage("om_recalled", { text: "ignored" })).toBe(false);

    now = 1600;
    repo.markLarkMessagesCompleted(["om_1"]);
    expect(repo.getLarkMessageById("om_1")).toMatchObject({
      status: "completed",
      completedAt: 1600,
      updatedAt: 1600
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

    now = 1700;
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
      updatedAt: 1700
    });
  });

  it("records card actions without Lark message ids and dedupes by event id", () => {
    const repo = createConversationRepository(db, { now: () => now });

    const action = repo.insertLarkMessage({
      eventId: "event_card_1",
      larkUserId: "ou_operator",
      larkGroupId: "oc_group",
      larkThreadId: "om_thread",
      conversationKey: "group:oc_group",
      codexThreadId: "thread_1",
      codexTurnId: "turn_1",
      routeKind: "card_action",
      status: "completed",
      text: "/stop",
      rawEventJson: "{}"
    });
    const duplicate = repo.insertLarkMessage({
      eventId: "event_card_1",
      larkUserId: "ou_operator",
      conversationKey: "group:oc_group",
      routeKind: "card_action",
      status: "completed",
      text: "/next",
      rawEventJson: "{}"
    });

    expect(action).toMatchObject({
      larkMessageId: undefined,
      eventId: "event_card_1",
      larkUserId: "ou_operator",
      larkGroupId: "oc_group",
      larkThreadId: "om_thread",
      conversationKey: "group:oc_group",
      codexThreadId: "thread_1",
      codexTurnId: "turn_1",
      routeKind: "card_action",
      status: "completed",
      text: "/stop",
      receivedAt: 1000,
      updatedAt: 1000
    });
    expect(duplicate).toEqual(action);
    expect(repo.getLarkMessageByEventId("event_card_1")).toEqual(action);
    expect(() =>
      repo.insertLarkMessage({
        eventId: "event_message_1",
        larkUserId: "ou_operator",
        routeKind: "message",
        status: "processing",
        text: "missing message id"
      })
    ).toThrow(/larkMessageId is required/);
  });

  it("finds and replaces Codex threads by group conversation and Lark thread id", () => {
    const repo = createConversationRepository(db, { now: () => now });

    const first = repo.upsertCodexThread({
      codexThreadId: "thread-topic-1",
      conversationKey: "group:oc_group",
      larkThreadId: "om_root",
      role: "guest"
    });
    expect(first).toMatchObject({
      codexThreadId: "thread-topic-1",
      conversationKey: "group:oc_group",
      larkThreadId: "om_root",
      role: "guest"
    });
    expect(repo.getCodexThreadByConversationAndLarkThread("group:oc_group", "om_root")).toEqual(first);

    now = 2000;
    repo.updateCodexThreadTokenUsage({
      codexThreadId: "thread-topic-1",
      conversationKey: "group:oc_group",
      role: "guest",
      totalTokens: 321,
      tokenUsageJson: '{"totalTokens":321}'
    });

    now = 3000;
    const replacement = repo.replaceCodexThreadForLarkThread("group:oc_group", "om_root", {
      codexThreadId: "thread-topic-2",
      role: "guest"
    });
    expect(repo.getCodexThreadById("thread-topic-1")).toBeUndefined();
    expect(replacement).toMatchObject({
      id: first.id,
      codexThreadId: "thread-topic-2",
      conversationKey: "group:oc_group",
      larkThreadId: "om_root",
      totalTokens: 0,
      tokenUsageJson: "{}",
      updatedAt: 3000
    });
    expect(repo.getCodexThreadByConversationAndLarkThread("group:oc_group", "om_root")).toEqual(replacement);
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
