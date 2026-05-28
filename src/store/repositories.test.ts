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
    const workspace = path.join(tempDir, "workspaces", "p2p_ou_123");
    const profileCodexHome = path.join(tempDir, "profiles", "guest", "codex");

    const created = repo.create({
      conversationKey: "p2p_ou_123",
      type: "p2p",
      chatId: "ou_123",
      name: "Guest User",
      responseMode: "all",
      profile: "guest",
      codexThreadId: "thread-1",
      workspace,
      profileCodexHome
    });

    expect(created).toMatchObject({
      id: 1,
      conversationKey: "p2p_ou_123",
      type: "p2p",
      chatId: "ou_123",
      name: "Guest User",
      profile: "guest",
      codexThreadId: "thread-1",
      workspace,
      profileCodexHome,
      createdAt: 1000,
      updatedAt: 1000
    });
    expect(repo.getByConversationKey("p2p_ou_123")).toEqual(created);
    expect(repo.getByTypeAndChatId("p2p", "ou_123")).toEqual(created);
    expect(repo.getByCodexThreadId("thread-1")).toEqual(created);
    expect(repo.list()).toEqual([created]);
  });

  it("creates group conversations with response modes and updates group settings", () => {
    const repo = createConversationRepository(db, { now: () => now });
    const workspace = path.join(tempDir, "workspaces", "group_oc_group");
    const profileCodexHome = path.join(tempDir, "profiles", "owner", "codex");

    const created = repo.create({
      conversationKey: "group_oc_group",
      type: "topic_group",
      chatId: "oc_group",
      name: "Topic Group",
      responseMode: "all_at",
      profile: "owner",
      codexThreadId: "thread-group",
      workspace,
      profileCodexHome
    });

    expect(created).toMatchObject({
      conversationKey: "group_oc_group",
      type: "topic_group",
      chatId: "oc_group",
      name: "Topic Group",
      responseMode: "all_at",
      profile: "owner"
    });
    expect(repo.getByTypeAndChatId("topic_group", "oc_group")).toEqual(created);

    now = 2000;
    const updated = repo.updateConversationSettings("group_oc_group", {
      type: "group",
      name: "Renamed Group",
      responseMode: "none"
    });
    expect(updated).toMatchObject({
      type: "group",
      name: "Renamed Group",
      responseMode: "none",
      profile: "owner",
      updatedAt: 2000
    });
  });

  it("updates thread bindings transactionally", () => {
    const repo = createConversationRepository(db, { now: () => now });
    const workspace = path.join(tempDir, "workspaces", "p2p_ou_456");
    const profileCodexHome = path.join(tempDir, "profiles", "owner", "codex");

    repo.create({
      conversationKey: "p2p_ou_456",
      type: "p2p",
      chatId: "ou_456",
      name: "Owner User",
      profile: "owner",
      codexThreadId: "thread-old",
      workspace,
      profileCodexHome
    });

    now = 2000;
    const updated = repo.updateThreadBinding("p2p_ou_456", {
      codexThreadId: "thread-new"
    });

    expect(updated.codexThreadId).toBe("thread-new");
    expect(updated.updatedAt).toBe(2000);
    expect(updated.workspace).toBe(workspace);
    expect(updated.profileCodexHome).toBe(profileCodexHome);

    repo.upsertCodexThread({
      codexThreadId: "thread-new",
      conversationKey: "p2p_ou_456",
      profile: "owner",
      codexThreadHasRollout: false
    });

    now = 3000;
    repo.markThreadHasRollout("p2p_ou_456", "thread-new");
    expect(repo.getByConversationKey("p2p_ou_456")).toMatchObject({
      codexThreadId: "thread-new",
      updatedAt: 2000
    });
    expect(repo.getCodexThreadById("thread-new")).toMatchObject({
      codexThreadHasRollout: true,
      updatedAt: 3000
    });

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(["conversations", "lark_doc_watcher", "lark_messages", "threads"]);
  });

  it("defaults, updates, and lists codex thread workspaces", () => {
    const repo = createConversationRepository(db, { now: () => now });
    const workspace = path.join(tempDir, "workspaces", "p2p_ou_456");
    const conversationWorkspace = path.join(tempDir, "workspaces", "conversation-new");
    const topicWorkspace = path.join(tempDir, "workspaces", "topic");
    const topicWorkspaceNew = path.join(tempDir, "workspaces", "topic-new");
    const profileCodexHome = path.join(tempDir, "profiles", "owner", "codex");

    repo.create({
      conversationKey: "p2p_ou_456",
      type: "p2p",
      chatId: "ou_456",
      name: "Owner User",
      profile: "owner",
      codexThreadId: "thread-main",
      workspace,
      profileCodexHome
    });

    now = 1100;
    const mainThread = repo.upsertCodexThread({
      codexThreadId: "thread-main",
      conversationKey: "p2p_ou_456",
      profile: "owner"
    });
    expect(mainThread.workspace).toBe(workspace);
    expect(mainThread.category).toBe("previous_main");

    now = 1200;
    const topicThread = repo.upsertCodexThread({
      codexThreadId: "thread-topic",
      conversationKey: "p2p_ou_456",
      workspace: topicWorkspace,
      profile: "owner",
      larkThreadId: "topic-1"
    });
    expect(topicThread.workspace).toBe(topicWorkspace);
    expect(topicThread.category).toBe("thread");
    expect(topicThread.createMethod).toBe("fresh");

    now = 1300;
    expect(repo.updateConversationWorkspace("p2p_ou_456", conversationWorkspace)).toMatchObject({
      workspace: conversationWorkspace,
      updatedAt: 1300
    });
    expect(repo.getCodexThreadById("thread-main")).toMatchObject({
      workspace: conversationWorkspace,
      updatedAt: 1300
    });
    expect(repo.getCodexThreadById("thread-topic")).toMatchObject({
      workspace: topicWorkspace,
      updatedAt: 1200
    });

    now = 1400;
    expect(repo.updateCodexThreadWorkspace("thread-topic", topicWorkspaceNew)).toMatchObject({
      workspace: topicWorkspaceNew,
      updatedAt: 1400
    });
    expect(repo.getByConversationKey("p2p_ou_456")).toMatchObject({
      workspace: conversationWorkspace
    });
    expect(repo.listCodexThreadsByConversation("p2p_ou_456").map((thread) => thread.codexThreadId)).toEqual([
      "thread-topic",
      "thread-main"
    ]);
    expect(repo.listRecentThreadWorkspaces(0, 10)).toEqual([topicWorkspaceNew, conversationWorkspace]);
    expect(repo.listRecentThreadWorkspaces(1350, 10)).toEqual([topicWorkspaceNew]);
  });

  it("upserts Lark doc watchers by file and records latest comment time", () => {
    const repo = createConversationRepository(db, { now: () => now });

    const created = repo.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_1",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    expect(created).toMatchObject({
      id: 1,
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_1",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_token",
      createdAt: 1000,
      updatedAt: 1000
    });

    now = 1500;
    expect(repo.touchLarkDocWatcherCommentReceived("docx", "doc_token", 1234567890)).toBe(true);
    expect(repo.getLarkDocWatcherByFile("docx", "doc_token")).toMatchObject({
      lastCommentReceivedAt: 1234567890,
      updatedAt: 1500
    });

    now = 2000;
    const replaced = repo.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_2",
      watchMode: "none",
      watchUrl: "https://example.feishu.cn/docx/doc_token?from=updated"
    });
    expect(replaced).toMatchObject({
      id: 1,
      threadId: "thread_2",
      watchMode: "none",
      watchUrl: "https://example.feishu.cn/docx/doc_token?from=updated",
      lastCommentReceivedAt: 1234567890,
      createdAt: 1000,
      updatedAt: 2000
    });
    expect(repo.listLarkDocWatchersByThread("thread_1")).toEqual([]);
    expect(repo.listLarkDocWatchersByThread("thread_2")).toEqual([replaced]);
    expect(repo.touchLarkDocWatcherCommentReceived("docx", "missing", 1)).toBe(false);
  });

  it("migrates Lark doc watchers between replacement threads", () => {
    const repo = createConversationRepository(db, { now: () => now });

    repo.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_a",
      threadId: "thread_old",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_a"
    });
    repo.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_b",
      threadId: "thread_old",
      watchMode: "all",
      watchUrl: "https://example.feishu.cn/docx/doc_b"
    });
    const untouched = repo.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_c",
      threadId: "thread_other",
      watchMode: "none",
      watchUrl: "https://example.feishu.cn/docx/doc_c"
    });

    now = 2000;
    expect(repo.migrateLarkDocWatchersToThread("thread_old", "thread_new")).toBe(2);
    expect(repo.listLarkDocWatchersByThread("thread_old")).toEqual([]);
    expect(repo.listLarkDocWatchersByThread("thread_new")).toEqual([
      expect.objectContaining({ fileToken: "doc_b", threadId: "thread_new", updatedAt: 2000 }),
      expect.objectContaining({ fileToken: "doc_a", threadId: "thread_new", updatedAt: 2000 })
    ]);
    expect(repo.listLarkDocWatchersByThread("thread_other")).toEqual([untouched]);
    expect(repo.migrateLarkDocWatchersToThread("thread_new", "thread_new")).toBe(0);
  });

  it("tracks processed Lark doc comment ids", () => {
    const repo = createConversationRepository(db, { now: () => now });

    expect(repo.hasProcessedDocComment("comment_1")).toBe(false);

    repo.insertLarkMessage({
      larkMessageId: "om_regular",
      eventId: "event_regular",
      larkUserId: "ou_456",
      docCommentId: "comment_1",
      routeKind: "message",
      status: "processing",
      text: "not a doc comment",
      rawEventJson: "{}"
    });
    expect(repo.hasProcessedDocComment("comment_1")).toBe(false);

    const docComment = repo.insertLarkMessage({
      larkMessageId: "om_doc_comment",
      eventId: "event_doc_comment",
      larkUserId: "ou_456",
      docCommentId: "comment_1",
      routeKind: "doc_comment",
      status: "processing",
      text: "doc follow-up",
      rawEventJson: "{}"
    });

    expect(docComment).toMatchObject({
      larkMessageId: "om_doc_comment",
      docCommentId: "comment_1",
      routeKind: "doc_comment"
    });
    expect(repo.getLarkMessageById("om_doc_comment")).toMatchObject({ docCommentId: "comment_1" });
    expect(repo.hasProcessedDocComment("comment_1")).toBe(true);

    const docCommentReplySteer = repo.insertLarkMessage({
      larkMessageId: "om_doc_comment_reply_steer",
      eventId: "event_doc_comment_reply_steer",
      larkUserId: "ou_456",
      docCommentId: "comment_2",
      routeKind: "doc_comment_reply_steer",
      status: "processing",
      text: "steered doc follow-up",
      rawEventJson: "{}"
    });

    expect(docCommentReplySteer).toMatchObject({
      larkMessageId: "om_doc_comment_reply_steer",
      docCommentId: "comment_2",
      routeKind: "doc_comment_reply_steer"
    });
    expect(repo.hasProcessedDocComment("comment_2")).toBe(true);
  });

  it("lists contiguous steered messages before a processing message in the same turn", () => {
    const repo = createConversationRepository(db, { now: () => now });
    const base = {
      larkUserId: "ou_456",
      conversationKey: "p2p_ou_456",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      routeKind: "doc_comment" as const,
      text: "doc comment",
      rawEventJson: "{}"
    };

    repo.insertLarkMessage({
      ...base,
      larkMessageId: "om_old_steered",
      eventId: "event_old_steered",
      status: "steered"
    });
    now += 1;
    repo.insertLarkMessage({
      ...base,
      larkMessageId: "om_boundary",
      eventId: "event_boundary",
      status: "completed"
    });
    now += 1;
    repo.insertLarkMessage({
      ...base,
      larkMessageId: "om_steered_1",
      eventId: "event_steered_1",
      status: "steered"
    });
    now += 1;
    repo.insertLarkMessage({
      ...base,
      larkMessageId: "om_other_turn",
      eventId: "event_other_turn",
      codexTurnId: "turn-other",
      status: "steered"
    });
    now += 1;
    repo.insertLarkMessage({
      ...base,
      larkMessageId: "om_steered_2",
      eventId: "event_steered_2",
      status: "steered"
    });
    now += 1;
    const processing = repo.insertLarkMessage({
      ...base,
      larkMessageId: "om_processing",
      eventId: "event_processing",
      routeKind: "steered_message",
      status: "processing",
      text: "extra context"
    });

    expect(repo.listContiguousSteeredLarkMessagesBefore(processing).map((message) => message.larkMessageId)).toEqual([
      "om_steered_1",
      "om_steered_2"
    ]);
  });

  it("records runtime codex threads, messages, and token usage by business ids", () => {
    const repo = createConversationRepository(db, { now: () => now });
    const workspace = path.join(tempDir, "workspaces", "p2p_ou_456");
    const profileCodexHome = path.join(tempDir, "profiles", "guest", "codex");

    repo.create({
      conversationKey: "p2p_ou_456",
      type: "p2p",
      chatId: "ou_456",
      name: "Guest User",
      profile: "guest",
      codexThreadId: "thread-1",
      workspace,
      profileCodexHome
    });

    now = 1200;
    const thread = repo.upsertCodexThread({
      codexThreadId: "thread-1",
      conversationKey: "p2p_ou_456",
      profile: "guest"
    });
    expect(thread).toMatchObject({
      id: 1,
      codexThreadId: "thread-1",
      conversationKey: "p2p_ou_456",
      name: "新会话",
      profile: "guest",
      model: undefined,
      effort: undefined,
      codexThreadHasRollout: false,
      totalTokens: 0,
      tokenUsageJson: "{}"
    });

    now = 1225;
    expect(
      repo.updateCodexThreadModelSettings({
        codexThreadId: "thread-1",
        model: "gpt-5.4",
        effort: "high"
      })
    ).toMatchObject({
      codexThreadId: "thread-1",
      model: "gpt-5.4",
      effort: "high",
      updatedAt: 1225
    });

    now = 1250;
    repo.markThreadHasRollout("p2p_ou_456", "thread-1");
    expect(repo.getCodexThreadById("thread-1")).toMatchObject({
      codexThreadHasRollout: true,
      updatedAt: 1250
    });

    now = 1275;
    repo.updateCodexThreadGoalStatus({
      codexThreadId: "thread-1",
      goalStatus: "active",
      goalUpdatedAt: 1260
    });
    expect(repo.getCodexThreadById("thread-1")).toMatchObject({
      goalStatus: "active",
      goalUpdatedAt: 1260,
      updatedAt: 1275
    });

    now = 1300;
    const message = repo.insertLarkMessage({
      larkMessageId: "om_1",
      eventId: "event_1",
      larkUserId: "ou_456",
      conversationKey: "p2p_ou_456",
      routeKind: "queued_message",
      status: "queued",
      text: "hello",
      larkCreateTime: 1001,
      rawEventJson: "{}"
    });
    expect(message).toMatchObject({
      id: 1,
      larkMessageId: "om_1",
      eventId: "event_1",
      larkUserId: "ou_456",
      conversationKey: "p2p_ou_456",
      routeKind: "queued_message",
      status: "queued",
      text: "hello",
      receivedAt: 1300,
      updatedAt: 1300
    });
    const duplicateEvent = repo.insertLarkMessage({
      larkMessageId: "om_duplicate_event",
      eventId: "event_1",
      larkUserId: "ou_456",
      conversationKey: "p2p_ou_456",
      routeKind: "message",
      status: "processing",
      text: "duplicate",
      rawEventJson: "{}"
    });
    expect(duplicateEvent).toEqual(message);

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
      conversationKey: "p2p_ou_456",
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
    expect(repo.countUnfinishedLarkMessagesByThread("thread-1")).toBe(1);

    now = 1500;
    repo.markLarkMessagesSteered(["om_1"], {
      conversationKey: "p2p_ou_456",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1"
    });
    expect(repo.getLarkMessageById("om_1")).toMatchObject({
      status: "steered",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      updatedAt: 1500
    });
    expect(repo.countUnfinishedLarkMessagesByThread("thread-1")).toBe(0);

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
      conversationKey: "p2p_ou_456",
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
      conversationKey: "p2p_ou_456",
      routeKind: "message",
      status: "processing",
      text: "processing",
      rawEventJson: "{}"
    });
    repo.insertLarkMessage({
      larkMessageId: "om_3",
      eventId: "event_3",
      larkUserId: "ou_456",
      conversationKey: "p2p_ou_456",
      routeKind: "queued_message",
      status: "queued",
      text: "queued",
      rawEventJson: "{}"
    });
    expect(repo.listUnfinishedLarkMessages().map((row) => row.larkMessageId)).toEqual(["om_2", "om_3"]);

    now = 1700;
    repo.updateCodexThreadTokenUsage({
      codexThreadId: "thread-1",
      conversationKey: "p2p_ou_456",
      profile: "guest",
      inputTokens: 80,
      outputTokens: 40,
      cachedInputTokens: 20,
      reasoningOutputTokens: 10,
      totalTokens: 123,
      contextTokens: 60,
      contextWindow: 200,
      tokenUsageJson: '{"totalTokens":123}'
    });
    expect(repo.getCodexThreadById("thread-1")).toMatchObject({
      codexThreadId: "thread-1",
      inputTokens: 80,
      outputTokens: 40,
      cachedInputTokens: 20,
      reasoningOutputTokens: 10,
      totalTokens: 123,
      contextTokens: 60,
      contextWindow: 200,
      model: "gpt-5.4",
      effort: "high",
      codexThreadHasRollout: true,
      goalStatus: "active",
      goalUpdatedAt: 1260,
      tokenUsageJson: '{"totalTokens":123}',
      updatedAt: 1700
    });

    now = 1710;
    expect(
      repo.updateLarkMessageTokenUsage({
        larkMessageId: "om_1",
        inputTokens: 30,
        outputTokens: 12,
        cachedInputTokens: 8,
        reasoningOutputTokens: 3,
        tokenUsageJson: '{"turn":"usage"}'
      })
    ).toMatchObject({
      larkMessageId: "om_1",
      inputTokens: 30,
      outputTokens: 12,
      cachedInputTokens: 8,
      reasoningOutputTokens: 3,
      tokenUsageJson: '{"turn":"usage"}',
      updatedAt: 1710
    });
    expect(repo.updateLarkMessageTokenUsage({
      larkMessageId: "om_missing",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      tokenUsageJson: "{}"
    })).toBeUndefined();

    now = 1725;
    repo.clearCodexThreadGoalStatus("thread-1");
    expect(repo.getCodexThreadById("thread-1")).toMatchObject({
      goalStatus: "none",
      goalUpdatedAt: undefined,
      inputTokens: 80,
      outputTokens: 40,
      updatedAt: 1725
    });
    repo.insertLarkMessage({
      larkMessageId: "om_side",
      eventId: "event_side",
      larkUserId: "ou_456",
      conversationKey: "p2p_ou_456",
      routeKind: "side_message",
      status: "processing",
      text: "side",
      agentCardMessageId: "om_side_card",
      rawEventJson: "{}"
    });
    now = 1800;
    repo.markLarkMessagesProcessing(["om_side"], {
      conversationKey: "p2p_ou_456",
      codexThreadId: "thread-1",
      codexTurnId: "turn-side"
    });
    repo.updateLarkMessageTokenUsage({
      larkMessageId: "om_side",
      inputTokens: 7,
      outputTokens: 2,
      cachedInputTokens: 3,
      reasoningOutputTokens: 1,
      tokenUsageJson: '{"turn":"side"}'
    });
    now = 2800;
    repo.markLarkMessagesCompleted(["om_side"]);
    expect(repo.getLarkMessageById("om_side")).toMatchObject({
      routeKind: "side_message",
      agentCardMessageId: "om_side_card",
      codexTurnId: "turn-side"
    });
    expect(repo.getCodexThreadById("thread-1")).toMatchObject({
      inputTokens: 87,
      outputTokens: 42,
      cachedInputTokens: 23,
      reasoningOutputTokens: 11,
      totalTokens: 132,
      contextTokens: 60,
      contextWindow: 200
    });
    expect(repo.getLarkMessageUsageTargetForTurn("thread-1", "turn-1")).toMatchObject({
      larkMessageId: "om_1"
    });
    expect(repo.getCodexThreadWorkStats("thread-1")).toEqual({
      turnCount: 1,
      totalWorkDurationMs: 200
    });
    expect(repo.getCodexThreadStatusStats("thread-1")).toEqual({
      userMessageCount: 2,
      turnCount: 1,
      totalWorkDurationMs: 200
    });
    expect(repo.getConversationStatusStats("p2p_ou_456")).toEqual({
      topicCount: 1,
      userMessageCount: 5,
      inputTokens: 87,
      outputTokens: 42,
      cachedInputTokens: 23,
      reasoningOutputTokens: 11,
      totalTokens: 132,
      totalWorkDurationMs: 200
    });

    repo.insertLarkMessage({
      larkMessageId: "om_steer_only_1",
      eventId: "event_steer_only_1",
      larkUserId: "ou_456",
      conversationKey: "p2p_ou_456",
      codexThreadId: "thread-1",
      codexTurnId: "turn-steer-only",
      routeKind: "steered_message",
      status: "processing",
      text: "first steer",
      rawEventJson: "{}"
    });
    now = 2810;
    repo.insertLarkMessage({
      larkMessageId: "om_steer_only_2",
      eventId: "event_steer_only_2",
      larkUserId: "ou_456",
      conversationKey: "p2p_ou_456",
      codexThreadId: "thread-1",
      codexTurnId: "turn-steer-only",
      routeKind: "steered_message",
      status: "processing",
      text: "latest steer",
      rawEventJson: "{}"
    });
    now = 2820;
    repo.insertLarkMessage({
      larkMessageId: "om_doc_reply_steer_only",
      eventId: "event_doc_reply_steer_only",
      larkUserId: "ou_456",
      conversationKey: "p2p_ou_456",
      codexThreadId: "thread-1",
      codexTurnId: "turn-steer-only",
      routeKind: "doc_comment_reply_steer",
      status: "processing",
      text: "doc reply steer",
      rawEventJson: "{}"
    });
    expect(repo.getLarkMessageUsageTargetForTurn("thread-1", "turn-steer-only")).toBeUndefined();
    expect(repo.getLatestSteeredLarkMessageForTurn("thread-1", "turn-steer-only")).toMatchObject({
      larkMessageId: "om_steer_only_2"
    });

    now = 1750;
    expect(
      repo.updateCodexThreadCard({
        codexThreadId: "thread-1",
        conversationKey: "p2p_ou_456",
        profile: "guest",
        creatorOpenId: "ou_456",
        cardMessageId: "om_card"
      })
    ).toMatchObject({
      codexThreadId: "thread-1",
      creatorOpenId: "ou_456",
      cardMessageId: "om_card",
      updatedAt: 1750
    });

    now = 1800;
    expect(repo.updateCodexThreadName("thread-1", "排查消息队列")).toMatchObject({
      codexThreadId: "thread-1",
      name: "排查消息队列",
      updatedAt: 1800
    });
    expect(repo.updateCodexThreadName("thread-missing", "不会创建")).toBeUndefined();
  });

  it("records non-message actions without Lark message ids and dedupes by event id", () => {
    const repo = createConversationRepository(db, { now: () => now });

    const action = repo.insertLarkMessage({
      eventId: "event_card_1",
      larkUserId: "ou_operator",
      larkGroupId: "oc_group",
      larkThreadId: "om_thread",
      conversationKey: "group_oc_group",
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
      conversationKey: "group_oc_group",
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
      conversationKey: "group_oc_group",
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

    const menuAction = repo.insertLarkMessage({
      eventId: "event_menu_1",
      larkUserId: "ou_operator",
      conversationKey: "p2p_ou_operator",
      routeKind: "menu_action",
      status: "completed",
      text: "queue",
      rawEventJson: "{}"
    });
    const duplicateMenuAction = repo.insertLarkMessage({
      eventId: "event_menu_1",
      larkUserId: "ou_operator",
      conversationKey: "p2p_ou_operator",
      routeKind: "menu_action",
      status: "completed",
      text: "status",
      rawEventJson: "{}"
    });
    expect(menuAction).toMatchObject({
      larkMessageId: undefined,
      eventId: "event_menu_1",
      routeKind: "menu_action",
      text: "queue"
    });
    expect(duplicateMenuAction).toEqual(menuAction);
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
      conversationKey: "group_oc_group",
      larkThreadId: "om_root",
      profile: "guest",
      codexThreadHasRollout: false
    });
    expect(first).toMatchObject({
      codexThreadId: "thread-topic-1",
      conversationKey: "group_oc_group",
      larkThreadId: "om_root",
      category: "thread",
      profile: "guest"
    });
    expect(repo.getCodexThreadByConversationAndLarkThread("group_oc_group", "om_root")).toEqual(first);

    now = 2000;
    repo.updateCodexThreadTokenUsage({
      codexThreadId: "thread-topic-1",
      conversationKey: "group_oc_group",
      profile: "guest",
      inputTokens: 200,
      outputTokens: 100,
      cachedInputTokens: 50,
      reasoningOutputTokens: 25,
      totalTokens: 321,
      contextTokens: 300,
      contextWindow: 1000,
      tokenUsageJson: '{"totalTokens":321}'
    });
    expect(repo.getCodexThreadById("thread-topic-1")).toMatchObject({
      codexThreadHasRollout: true,
      totalTokens: 321
    });

    now = 3000;
    const replacement = repo.replaceCodexThreadForLarkThread("group_oc_group", "om_root", {
      codexThreadId: "thread-topic-2",
      profile: "guest"
    });
    expect(repo.getCodexThreadById("thread-topic-1")).toBeUndefined();
    expect(replacement).toMatchObject({
      id: first.id,
      codexThreadId: "thread-topic-2",
      conversationKey: "group_oc_group",
      larkThreadId: "om_root",
      category: "thread",
      totalTokens: 0,
      codexThreadHasRollout: false,
      tokenUsageJson: "{}",
      updatedAt: 3000
    });
    expect(repo.getCodexThreadByConversationAndLarkThread("group_oc_group", "om_root")).toEqual(replacement);
  });

  it("detects user messages for a Codex thread from lark messages", () => {
    const repo = createConversationRepository(db, { now: () => now });

    repo.upsertCodexThread({
      codexThreadId: "thread-topic-1",
      conversationKey: "group_oc_group",
      larkThreadId: "om_root",
      profile: "guest"
    });
    expect(repo.hasUserMessageForCodexThread("thread-topic-1")).toBe(false);

    repo.insertLarkMessage({
      larkMessageId: "om_control",
      eventId: "event_control",
      larkUserId: "ou_456",
      conversationKey: "group_oc_group",
      codexThreadId: "thread-topic-1",
      routeKind: "control_message",
      status: "processing",
      text: "/status"
    });
    repo.insertLarkMessage({
      larkMessageId: "om_side",
      eventId: "event_side",
      larkUserId: "ou_456",
      conversationKey: "group_oc_group",
      codexThreadId: "thread-topic-1",
      routeKind: "side_message",
      status: "processing",
      text: "side question"
    });
    expect(repo.hasUserMessageForCodexThread("thread-topic-1")).toBe(false);

    repo.insertLarkMessage({
      larkMessageId: "om_message",
      eventId: "event_message",
      larkUserId: "ou_456",
      conversationKey: "group_oc_group",
      codexThreadId: "thread-topic-1",
      routeKind: "message",
      status: "processing",
      text: "first real message"
    });
    expect(repo.hasUserMessageForCodexThread("thread-topic-1")).toBe(true);
    expect(repo.hasUserMessageForCodexThread("thread-topic-1", ["om_message"])).toBe(false);

    repo.upsertCodexThread({
      codexThreadId: "thread-topic-proxy",
      conversationKey: "group_oc_group",
      larkThreadId: "om_proxy_root",
      profile: "guest"
    });
    repo.insertLarkMessage({
      larkMessageId: "om_proxy",
      eventId: "event_proxy",
      larkUserId: "ou_456",
      conversationKey: "group_oc_group",
      codexThreadId: "thread-topic-proxy",
      routeKind: "thread_message",
      status: "processing",
      text: "proxy message"
    });
    expect(repo.hasUserMessageForCodexThread("thread-topic-proxy")).toBe(true);
    expect(repo.hasUserMessageForCodexThread("thread-topic-proxy", ["om_proxy"])).toBe(false);

    repo.upsertCodexThread({
      codexThreadId: "thread-topic-2",
      conversationKey: "group_oc_group",
      larkThreadId: "om_root_2",
      profile: "guest"
    });
    repo.insertLarkMessage({
      larkMessageId: "om_doc",
      eventId: "event_doc",
      larkUserId: "ou_456",
      docCommentId: "comment_1",
      conversationKey: "group_oc_group",
      codexThreadId: "thread-topic-2",
      routeKind: "doc_comment",
      status: "processing",
      text: "doc comment"
    });
    expect(repo.hasUserMessageForCodexThread("thread-topic-2")).toBe(true);
    expect(repo.hasUserMessageForCodexThread("thread-topic-2", ["om_doc"])).toBe(false);
  });

  it("lists fresh and fork child threads created since the latest message or doc comment", () => {
    const repo = createConversationRepository(db, { now: () => now });

    repo.upsertCodexThread({
      codexThreadId: "thread-parent",
      conversationKey: "group_oc_group",
      profile: "guest"
    });

    now = 1100;
    repo.insertLarkMessage({
      larkMessageId: "om_previous",
      eventId: "event_previous",
      larkUserId: "ou_456",
      conversationKey: "group_oc_group",
      codexThreadId: "thread-parent",
      routeKind: "message",
      status: "completed",
      text: "previous source message"
    });

    now = 1120;
    repo.insertLarkMessage({
      larkMessageId: "om_queued",
      eventId: "event_queued",
      larkUserId: "ou_456",
      conversationKey: "group_oc_group",
      codexThreadId: "thread-parent",
      routeKind: "queued_message",
      status: "queued",
      text: "queued text should not reset the window"
    });

    now = 1200;
    repo.upsertCodexThread({
      codexThreadId: "thread-fresh",
      conversationKey: "group_oc_group",
      larkThreadId: "topic_fresh",
      profile: "guest",
      parentCodexThreadId: "thread-parent",
      createMethod: "fresh",
      createRequestText: "fresh request"
    });

    now = 1250;
    repo.upsertCodexThread({
      codexThreadId: "thread-fork",
      conversationKey: "group_oc_group",
      larkThreadId: "topic_fork",
      profile: "guest",
      parentCodexThreadId: "thread-parent",
      createMethod: "fork",
      createRequestText: "fork request"
    });

    now = 1275;
    repo.upsertCodexThread({
      codexThreadId: "thread-resume",
      conversationKey: "group_oc_group",
      larkThreadId: "topic_resume",
      profile: "guest",
      parentCodexThreadId: "thread-parent",
      createMethod: "resume"
    });

    now = 1300;
    repo.insertLarkMessage({
      larkMessageId: "om_current",
      eventId: "event_current",
      larkUserId: "ou_456",
      conversationKey: "group_oc_group",
      codexThreadId: "thread-parent",
      routeKind: "message",
      status: "processing",
      text: "current source message"
    });

    expect(
      repo.listCreatedThreadsSinceLatestUserMessage("thread-parent", ["om_current"])
        .map((thread) => thread.codexThreadId)
    ).toEqual(["thread-fresh", "thread-fork"]);
    expect(repo.listCreatedThreadsSinceLatestUserMessage("thread-parent")).toEqual([]);

    now = 1400;
    repo.insertLarkMessage({
      larkMessageId: "om_doc",
      eventId: "event_doc",
      larkUserId: "ou_456",
      conversationKey: "group_oc_group",
      codexThreadId: "thread-parent",
      routeKind: "doc_comment",
      status: "completed",
      text: "doc comment",
      docCommentId: "comment_1"
    });

    now = 1500;
    repo.upsertCodexThread({
      codexThreadId: "thread-after-doc",
      conversationKey: "group_oc_group",
      larkThreadId: "topic_after_doc",
      profile: "guest",
      parentCodexThreadId: "thread-parent",
      createMethod: "fresh",
      createRequestText: "doc follow up branch"
    });

    expect(repo.listCreatedThreadsSinceLatestUserMessage("thread-parent").map((thread) => thread.codexThreadId)).toEqual([
      "thread-after-doc"
    ]);

    now = 1600;
    repo.insertLarkMessage({
      larkMessageId: "om_proxy_parent",
      eventId: "event_proxy_parent",
      larkUserId: "ou_456",
      conversationKey: "group_oc_group",
      codexThreadId: "thread-parent",
      routeKind: "thread_message",
      status: "completed",
      text: "proxy parent message"
    });

    now = 1700;
    repo.upsertCodexThread({
      codexThreadId: "thread-after-proxy",
      conversationKey: "group_oc_group",
      larkThreadId: "topic_after_proxy",
      profile: "guest",
      parentCodexThreadId: "thread-parent",
      createMethod: "fresh",
      createRequestText: "proxy follow up branch"
    });

    expect(repo.listCreatedThreadsSinceLatestUserMessage("thread-parent").map((thread) => thread.codexThreadId)).toEqual([
      "thread-after-proxy"
    ]);
  });

  it("rejects mismatched or unsafe conversation keys", () => {
    const repo = createConversationRepository(db);
    const workspace = path.join(tempDir, "workspaces", "p2p_ou_789");
    const profileCodexHome = path.join(tempDir, "profiles", "guest", "codex");

    expect(() =>
      repo.create({
        conversationKey: "p2p_ou_other",
        type: "p2p",
        chatId: "ou_789",
        name: "Guest User",
        profile: "guest",
        codexThreadId: "thread-1",
        workspace,
        profileCodexHome
      })
    ).toThrow(/must be p2p_ou_789/);

    expect(() =>
      repo.create({
        conversationKey: "p2p_../secret",
        type: "p2p",
        chatId: "../secret",
        name: "Guest User",
        profile: "guest",
        codexThreadId: "thread-1",
        workspace,
        profileCodexHome
      })
    ).toThrow();
  });
});
