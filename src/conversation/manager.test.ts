import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { TwinnyError } from "../errors.js";
import type {
  CodexThreadRecord,
  CodexTurnResult,
  ConversationRecord,
  IncomingLarkBotMenuAction,
  IncomingLarkMessage,
  LarkMessageRecord,
  TwinnyConfig
} from "../types.js";
import {
  ConversationManager,
  type CodexBridge,
  type ConversationRepository,
  type LarkFileDownloader,
  type LarkMessageReader,
  type LarkResponder,
  type LarkChatDirectory,
  type LarkUserDirectory
} from "./manager.js";

const config: TwinnyConfig = {
  home: "/tmp/twinny",
  codex: { binary: "codex", appServerListen: "stdio://" },
  lark: {
    appId: "cli_xxx",
    appSecretRef: "keychain:twinny/lark/app_secret",
    eventKey: "im.message.receive_v1",
    identity: "bot",
    workingReaction: "Typing",
    completedReaction: "DONE",
    maxMessageAgeSeconds: 60
  },
  owner: { openId: "ou_owner", displayName: "Owner" },
  roles: {
    owner: { codexHome: "/tmp/twinny/roles/owner/codex" },
    guest: { codexHome: "/tmp/twinny/roles/guest/codex" }
  }
};

describe("ConversationManager", () => {
  it("steers ordinary messages into the active turn and moves the typing reaction", async () => {
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "second"));
    await waitForExpect(() =>
      expect(codex.steerTurn).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread_1", turnId: "turn_1", input: wrappedMessage("second", "m2") })
      )
    );

    expect(codex.startTurn).toHaveBeenCalledTimes(1);
    expect(codex.steerTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread_1", turnId: "turn_1", input: wrappedMessage("second", "m2") })
    );
    expect(lark.addTypingReaction).toHaveBeenNthCalledWith(1, "m1");
    expect(lark.addTypingReaction).toHaveBeenNthCalledWith(2, "m2");
    expect(lark.removeReaction).toHaveBeenCalledWith({ messageId: "m1", reactionId: "r_m1" });

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() =>
      expect(lark.removeReaction).toHaveBeenCalledWith({ messageId: "m2", reactionId: "r_m2" })
    );
  });

  it("records ordinary message lifecycle and token usage in runtime history", async () => {
    const { repository } = createRepository();
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onTokenUsage }) => {
        await onTurnStarted?.("turn_1");
        await onTokenUsage?.({
          threadId,
          turnId: "turn_1",
          totalTokens: 42,
          raw: {
            threadId,
            turnId: "turn_1",
            usage: { total: { totalTokens: 42 } }
          }
        });
        return completed(threadId, "turn_1");
      })
    });
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "hello"));

    await waitForExpect(() => expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m1"]));
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "m1",
        eventId: "e_m1",
        larkUserId: "ou_guest",
        conversationKey: "p2p:ou_guest",
        routeKind: "message",
        status: "processing",
        text: "hello",
        larkCreateTime: 1234
      })
    );
    expect(repository.upsertCodexThread).toHaveBeenCalledWith({
      conversationKey: "p2p:ou_guest",
      codexThreadId: "thread_1",
      role: "guest",
      larkThreadId: undefined
    });
    expect(repository.markLarkMessagesProcessing).toHaveBeenCalledWith(["m1"], {
      conversationKey: "p2p:ou_guest",
      codexThreadId: "thread_1"
    });
    expect(repository.markLarkMessagesProcessing).toHaveBeenCalledWith(["m1"], {
      conversationKey: "p2p:ou_guest",
      codexThreadId: "thread_1",
      codexTurnId: "turn_1"
    });
    expect(repository.updateCodexThreadTokenUsage).toHaveBeenCalledWith({
      codexThreadId: "thread_1",
      conversationKey: "p2p:ou_guest",
      role: "guest",
      totalTokens: 42,
      tokenUsageJson: JSON.stringify({
        threadId: "thread_1",
        turnId: "turn_1",
        usage: { total: { totalTokens: 42 } }
      })
    });
  });

  it("records steered messages against the active Codex turn", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "second"));

    await waitForExpect(() =>
      expect(repository.markLarkMessagesProcessing).toHaveBeenCalledWith(["m2"], {
        conversationKey: "p2p:ou_guest",
        codexThreadId: "thread_1",
        codexTurnId: "turn_1"
      })
    );
    expect(repository.markLarkMessagesSteered).toHaveBeenCalledWith(["m1"], {
      conversationKey: "p2p:ou_guest",
      codexThreadId: "thread_1",
      codexTurnId: "turn_1"
    });
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "m2",
        routeKind: "steered_message",
        status: "processing",
        text: "second"
      })
    );

    turns[0]!.resolve(completed("thread_1", "turn_1"));
  });

  it("queues /queue and following ordinary messages for the next turn joined by newlines", async () => {
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ codex });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued"));
    manager.submitIncoming(message("m3", "second queued"));
    await waitForExpect(() => expect(manager.queueDepth("p2p:ou_guest")).toBe(2));

    expect(codex.startTurn).toHaveBeenCalledTimes(1);
    expect(codex.steerTurn).not.toHaveBeenCalled();

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: `${wrappedMessage("queued", "m2")}\n${wrappedMessage("second queued", "m3")}` })
    );

    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("splits pending queue batches at each explicit /queue message", async () => {
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ codex });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue 1"));
    manager.submitIncoming(message("m3", "2"));
    manager.submitIncoming(message("m4", "/queue 3"));
    manager.submitIncoming(message("m5", "/queue 4"));
    await waitForExpect(() => expect(manager.queueDepth("p2p:ou_guest")).toBe(4));

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: `${wrappedMessage("1", "m2")}\n${wrappedMessage("2", "m3")}` })
    );
    expect(manager.queueDepth("p2p:ou_guest")).toBe(2);

    turns[1]!.resolve(completed("thread_1", "turn_2"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(3));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ input: wrappedMessage("3", "m4") })
    );
    expect(manager.queueDepth("p2p:ou_guest")).toBe(1);

    turns[2]!.resolve(completed("thread_1", "turn_3"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(4));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ input: wrappedMessage("4", "m5") })
    );

    turns[3]!.resolve(completed("thread_1", "turn_4"));
  });

  it("removes recalled queued messages from memory and marks them recalled", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued"));
    await waitForExpect(() => expect(manager.queueDepth("p2p:ou_guest")).toBe(1));
    await waitForExpect(() => expect(repository.insertLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      larkMessageId: "m2",
      status: "queued"
    })));

    manager.submitMessageRecall({ eventId: "recall_1", messageId: "m2", raw: {} });

    await waitForExpect(() => expect(repository.markLarkMessageRecalled).toHaveBeenCalledWith("m2"));
    expect(manager.queueDepth("p2p:ou_guest")).toBe(0);

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForDelay();
    expect(codex.startTurn).toHaveBeenCalledTimes(1);
  });

  it("refreshes queued messages before processing and persists changed content", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const larkMessages = createLarkMessageReader({
      m2: fetchedLarkMessage("m2", "text", JSON.stringify({ text: "/queue edited" })),
      m3: fetchedLarkMessage("m3", "text", JSON.stringify({ text: "steer edited" }))
    });
    const manager = createManager({ repository, codex, larkMessages });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue old", { raw: rawReceiveEvent("m2", "/queue old") }));
    manager.submitIncoming(message("m3", "steer old", { raw: rawReceiveEvent("m3", "steer old") }));
    await waitForExpect(() => expect(manager.queueDepth("p2p:ou_guest")).toBe(2));
    await waitForExpect(() => expect(repository.insertLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      larkMessageId: "m2",
      status: "queued"
    })));

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(larkMessages.getMessage).toHaveBeenCalledWith("m2");
    expect(larkMessages.getMessage).toHaveBeenCalledWith("m3");
    expect(repository.updateQueuedLarkMessage).toHaveBeenCalledWith(
      "m2",
      expect.objectContaining({
        text: "edited",
        rawEventJson: JSON.stringify(rawReceiveEvent("m2", "/queue edited"))
      })
    );
    expect(repository.updateQueuedLarkMessage).toHaveBeenCalledWith(
      "m3",
      expect.objectContaining({
        text: "steer edited",
        rawEventJson: JSON.stringify(rawReceiveEvent("m3", "steer edited"))
      })
    );
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: `${wrappedMessage("edited", "m2")}\n${wrappedMessage("steer edited", "m3")}` })
    );

    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("uses stored queued content when refreshing latest Lark content fails", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const larkMessages = createLarkMessageReader(new Error("message fetch failed"));
    const logger = createLogger();
    const manager = createManager({ repository, codex, larkMessages, logger });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue stored", { raw: rawReceiveEvent("m2", "/queue stored") }));
    await waitForExpect(() => expect(manager.queueDepth("p2p:ou_guest")).toBe(1));

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: wrappedMessage("stored", "m2") })
    );
    expect(repository.updateQueuedLarkMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m2" }),
      "failed to refresh queued Lark message; using stored content"
    );

    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("ignores recall notifications for non-queued messages", async () => {
    const { repository } = createRepository();
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(repository.insertLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      larkMessageId: "m1",
      status: "processing"
    })));

    manager.submitMessageRecall({ eventId: "recall_1", messageId: "m1", raw: {} });

    await waitForDelay();
    expect(repository.markLarkMessageRecalled).not.toHaveBeenCalled();
    expect(repository.updateQueuedLarkMessage).not.toHaveBeenCalled();
  });

  it("records queued messages as cleared when /stop drains the pending batch", async () => {
    const { repository } = createRepository();
    const { codex } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued"));
    await waitForExpect(() => expect(manager.queueDepth("p2p:ou_guest")).toBe(1));
    manager.submitIncoming(message("m3", "/stop"));

    await waitForExpect(() => expect(repository.markLarkMessagesCleared).toHaveBeenCalledWith(["m2"]));
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "m2",
        routeKind: "queued_message",
        status: "queued",
        text: "queued"
      })
    );
    expect(repository.markLarkMessagesInterrupted).toHaveBeenCalledWith(["m1"]);
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m3"]);
    expect(lark.replyText).toHaveBeenCalledWith("m3", "已停止当前任务，清空 1 条待处理消息。");
  });

  it("replies to /help with available slash command usage", async () => {
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark });

    manager.submitIncoming(message("m1", "/help"));

    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledTimes(1));
    expect(lark.replyText).toHaveBeenCalledWith(
      "m1",
      expect.stringContaining("/help - 查看可用指令和使用说明")
    );
    expect(lark.replyText).toHaveBeenCalledWith("m1", expect.stringContaining("/new -"));
    expect(lark.replyText).toHaveBeenCalledWith("m1", expect.stringContaining("/stop -"));
    expect(lark.replyText).toHaveBeenCalledWith("m1", expect.stringContaining("/next -"));
    expect(lark.replyText).toHaveBeenCalledWith("m1", expect.stringContaining("/steer -"));
    expect(lark.replyText).toHaveBeenCalledWith("m1", expect.stringContaining("/status -"));
    expect(lark.replyText).toHaveBeenCalledWith("m1", expect.stringContaining("/queue <message> -"));
    expect(codex.startTurn).not.toHaveBeenCalled();
  });

  it("replies to /status with conversation, thread, and token usage", async () => {
    const row = conversationRecord({ codexThreadId: "thread_status" });
    const { repository } = createRepository(row);
    vi.mocked(repository.getCodexThreadById).mockReturnValue({
      id: 1,
      codexThreadId: "thread_status",
      conversationKey: "p2p:ou_guest",
      role: "guest",
      totalTokens: 100,
      tokenUsageJson: JSON.stringify({
        tokenUsage: {
          total: {
            totalTokens: 100,
            inputTokens: 80,
            cachedInputTokens: 40,
            outputTokens: 20,
            reasoningOutputTokens: 5
          }
        }
      }),
      createdAt: 100,
      updatedAt: 100
    });
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "/status"));

    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledTimes(1));
    expect(lark.replyText).toHaveBeenCalledWith(
      "m1",
      [
        "OUID: ou_guest",
        "Conversation Key: p2p:ou_guest",
        "Codex Thread ID: thread_status",
        "Thread Token Usage:",
        "- total: 100",
        "- input: 80",
        "- output: 20",
        "- cached input: 40",
        "- reasoning output: 5",
        "- cache hit rate: 50.00%"
      ].join("\n")
    );
    expect(codex.readAccountRateLimits).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m1"]);
  });

  it("includes account usage windows in /status for the owner", async () => {
    const row = conversationRecord({
      conversationKey: "p2p:ou_owner",
      chatId: "ou_owner",
      role: "owner",
      codexThreadId: "thread_owner"
    });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "/status", { senderOpenId: "ou_owner", senderName: "Owner" }));

    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledTimes(1));
    expect(codex.readAccountRateLimits).toHaveBeenCalledWith({ role: "owner" });
    expect(lark.replyText).toHaveBeenCalledWith("m1", expect.stringContaining("Conversation Key: p2p:ou_owner"));
    expect(lark.replyText).toHaveBeenCalledWith("m1", expect.stringContaining("Codex Account Usage:"));
    expect(lark.replyText).toHaveBeenCalledWith("m1", expect.stringContaining("- 5h: 12.50% used"));
    expect(lark.replyText).toHaveBeenCalledWith("m1", expect.stringContaining("- 7d: 34.00% used"));
  });

  it("interrupts active turns and clears pending messages on /stop", async () => {
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued"));
    await waitForExpect(() => expect(manager.queueDepth("p2p:ou_guest")).toBe(1));
    manager.submitIncoming(message("m3", "/stop"));
    await waitForExpect(() =>
      expect(codex.interruptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "guest", threadId: "thread_1", turnId: "turn_1" })
      )
    );

    expect(codex.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "guest", threadId: "thread_1", turnId: "turn_1" })
    );
    expect(lark.removeReaction).toHaveBeenCalledWith({ messageId: "m1", reactionId: "r_m1" });
    expect(lark.replyText).toHaveBeenCalledWith("m3", "已停止当前任务，清空 1 条待处理消息。");

    turns[0]!.resolve(completed("thread_1", "turn_1", "interrupted"));
    await waitForDelay();
    expect(codex.startTurn).toHaveBeenCalledTimes(1);
  });

  it("interrupts the active message and starts only the next queued message on /next", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued one"));
    manager.submitIncoming(message("m3", "/queue queued two"));
    await waitForExpect(() => expect(manager.queueDepth("p2p:ou_guest")).toBe(2));

    manager.submitIncoming(message("m4", "/next"));
    await waitForExpect(() =>
      expect(codex.interruptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "guest", threadId: "thread_1", turnId: "turn_1" })
      )
    );
    expect(repository.markLarkMessagesInterrupted).toHaveBeenCalledWith(["m1"]);
    expect(repository.markLarkMessagesCleared).not.toHaveBeenCalledWith(["m2", "m3"]);

    turns[0]!.resolve(completed("thread_1", "turn_1", "interrupted"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: wrappedMessage("queued one", "m2") })
    );
    expect(manager.queueDepth("p2p:ou_guest")).toBe(1);
    expect(lark.replyText).toHaveBeenCalledWith(
      "m4",
      "已打断当前任务，将执行队列中的下一条消息。队列剩余 1 条。"
    );

    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("steers the next queued batch into the active turn on /steer", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue 1"));
    manager.submitIncoming(message("m3", "2"));
    manager.submitIncoming(message("m4", "/queue 3"));
    await waitForExpect(() => expect(manager.queueDepth("p2p:ou_guest")).toBe(3));

    manager.submitIncoming(message("m5", "/steer"));
    await waitForExpect(() => expect(codex.steerTurn).toHaveBeenCalledTimes(1));

    expect(codex.steerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "guest",
        threadId: "thread_1",
        turnId: "turn_1",
        input: `${wrappedMessage("1", "m2")}\n${wrappedMessage("2", "m3")}`
      })
    );
    expect(manager.queueDepth("p2p:ou_guest")).toBe(1);
    expect(repository.markLarkMessagesSteered).toHaveBeenCalledWith(["m1"], {
      conversationKey: "p2p:ou_guest",
      codexThreadId: "thread_1",
      codexTurnId: "turn_1"
    });
    expect(repository.markLarkMessagesProcessing).toHaveBeenCalledWith(["m2", "m3"], {
      conversationKey: "p2p:ou_guest",
      codexThreadId: "thread_1",
      codexTurnId: "turn_1"
    });
    expect(lark.replyText).toHaveBeenCalledWith("m5", "已将队列中的 2 条消息注入当前任务。队列剩余 1 条。");

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: wrappedMessage("3", "m4") })
    );

    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("keeps queued messages when /steer fails", async () => {
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    vi.mocked(codex.steerTurn).mockRejectedValueOnce(new Error("steer failed"));
    const manager = createManager({ codex, lark });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued one"));
    manager.submitIncoming(message("m3", "/queue queued two"));
    await waitForExpect(() => expect(manager.queueDepth("p2p:ou_guest")).toBe(2));

    manager.submitIncoming(message("m4", "/steer"));
    await waitForExpect(() => expect(codex.steerTurn).toHaveBeenCalledTimes(1));

    expect(manager.queueDepth("p2p:ou_guest")).toBe(2);
    expect(lark.replyText).toHaveBeenCalledWith("m4", "注入当前任务失败，队列保持不变。");

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: wrappedMessage("queued one", "m2") })
    );

    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("toggles bot menu queue mode and queues the next ordinary message", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    manager.submitBotMenuAction(botMenuAction("menu-1", "queue"));
    await waitForExpect(() =>
      expect(lark.sendTextToOpenId).toHaveBeenCalledWith(
        "ou_guest",
        "开启排队模式：你的下一条消息会排队等待当前工作结束。"
      )
    );
    manager.submitBotMenuAction(botMenuAction("menu-2", "queue"));
    await waitForExpect(() =>
      expect(lark.sendTextToOpenId).toHaveBeenCalledWith(
        "ou_guest",
        "退出排队模式：下一条消息会即时提交给模型。"
      )
    );
    manager.submitIncoming(message("m2", "immediate"));
    await waitForExpect(() => expect(codex.steerTurn).toHaveBeenCalledTimes(1));

    manager.submitBotMenuAction(botMenuAction("menu-3", "queue"));
    await waitForExpect(() => expect(lark.sendTextToOpenId).toHaveBeenCalledTimes(3));
    manager.submitIncoming(message("m3", "queued by menu"));

    expect(codex.steerTurn).toHaveBeenCalledTimes(1);
    await waitForExpect(() =>
      expect(repository.insertLarkMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          larkMessageId: "m3",
          routeKind: "queued_message",
          status: "queued",
          text: "queued by menu"
        })
      )
    );
    expect(manager.queueDepth("p2p:ou_guest")).toBe(1);

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: wrappedMessage("queued by menu", "m3") })
    );
    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("handles bot menu status and help as direct p2p replies", async () => {
    const row = conversationRecord({ codexThreadId: "thread_status" });
    const { repository } = createRepository(row);
    vi.mocked(repository.getCodexThreadById).mockReturnValue({
      id: 1,
      codexThreadId: "thread_status",
      conversationKey: "p2p:ou_guest",
      role: "guest",
      totalTokens: 10,
      tokenUsageJson: JSON.stringify({ usage: { total: { totalTokens: 10 } } }),
      createdAt: 100,
      updatedAt: 100
    });
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitBotMenuAction(botMenuAction("menu-status", "status"));
    manager.submitBotMenuAction(botMenuAction("menu-help", "help"));

    await waitForExpect(() => expect(lark.sendTextToOpenId).toHaveBeenCalledTimes(2));
    expect(lark.sendTextToOpenId).toHaveBeenCalledWith(
      "ou_guest",
      expect.stringContaining("Conversation Key: p2p:ou_guest")
    );
    expect(lark.sendTextToOpenId).toHaveBeenCalledWith("ou_guest", expect.stringContaining("Codex Thread ID: thread_status"));
    expect(lark.sendTextToOpenId).toHaveBeenCalledWith("ou_guest", expect.stringContaining("/help - 查看可用指令和使用说明"));
    expect(lark.replyText).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
  });

  it("interrupts active turns and binds a fresh thread on /new", async () => {
    const row = conversationRecord({ codexThreadId: "thread_old" });
    const { repository } = createRepository(row);
    const { codex, turns } = createDeferredCodex();
    vi.mocked(codex.startThread).mockResolvedValueOnce({ threadId: "thread_new" });
    vi.mocked(codex.resumeThread).mockImplementation(async ({ threadId }) => {
      if (threadId === "thread_new") {
        throw new TwinnyError("no rollout found for thread id thread_new", "CODEX_REQUEST_FAILED", {
          code: -32600,
          message: "no rollout found for thread id thread_new"
        });
      }
      return { threadId };
    });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue stale"));
    await waitForExpect(() => expect(manager.queueDepth("p2p:ou_guest")).toBe(1));
    manager.submitIncoming(message("m3", "/new"));
    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledWith("m3", "已新开 Codex thread：thread_new"));
    manager.submitIncoming(message("m4", "after new"));

    expect(codex.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "guest", threadId: "thread_old", turnId: "turn_1" })
    );
    expect(row.codexThreadId).toBe("thread_new");
    expect(lark.replyText).toHaveBeenCalledWith("m3", "已新开 Codex thread：thread_new");
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ threadId: "thread_new", input: wrappedMessage("after new", "m4") })
    );
    expect(codex.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread_old" }));
    expect(codex.resumeThread).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread_new" }));
    expect(lark.replyText).not.toHaveBeenCalledWith("m4", expect.stringMatching(/^WARN:/));
    await waitForExpect(() => expect(row.codexThreadHasRollout).toBe(true));

    turns[0]!.resolve(completed("thread_old", "turn_1", "interrupted"));
    turns[1]!.resolve(completed("thread_new", "turn_2"));
  });

  it("ignores unactivated group messages and only replies to bot mentions with an authorization hint", async () => {
    const { repository } = createRepository();
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g1", "hello"));
    await waitForDelay();

    expect(repository.insertLarkMessage).not.toHaveBeenCalled();
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(lark.replyText).not.toHaveBeenCalled();

    manager.submitIncoming(groupMessage("g2", "@_bot hello", { mentions: [botMention()] }));
    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("g2", "群聊未授权，需要 owner 发送 /activate 激活。")
    );
    expect(repository.insertLarkMessage).not.toHaveBeenCalled();
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
  });

  it("lets the owner activate a group with default at/guest mode and records the control message", async () => {
    const { repository, row } = createRepository();
    const codex = createCodex();
    const lark = createLarkResponder();
    const larkChats: LarkChatDirectory = {
      getChatName: vi.fn(async () => "Team Room")
    };
    const manager = createManager({ repository, codex, lark, larkChats, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g1", "/activate", { senderOpenId: "ou_owner", senderName: "Owner" }));

    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledWith("g1", "已激活群聊：Team Room\n响应模式：at\nRole：guest"));
    expect(row).toBeUndefined();
    expect(repository.findByConversationKey("group:oc_group")).toBeDefined();
    expect(codex.startThread).toHaveBeenCalledWith({
      role: "guest",
      cwd: "/tmp/twinny/workspaces/group:oc_group",
      approvalPolicy: "never"
    });
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "g1",
        larkGroupId: "oc_group",
        conversationKey: "group:oc_group",
        routeKind: "control_message",
        text: "/activate"
      })
    );
    expect(repository.findByConversationKey("group:oc_group")).toMatchObject({
      conversationKey: "group:oc_group",
      type: "group",
      chatId: "oc_group",
      name: "Team Room",
      responseMode: "at",
      role: "guest",
      workspace: "/tmp/twinny/workspaces/group:oc_group"
    });
  });

  it("keeps a group's first activated role immutable while allowing mode and name refreshes", async () => {
    const { repository } = createRepository();
    const lark = createLarkResponder();
    const larkChats: LarkChatDirectory = {
      getChatName: vi.fn()
        .mockResolvedValueOnce("Owner Room")
        .mockResolvedValueOnce("Renamed Room")
    };
    const manager = createManager({ repository, lark, larkChats, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g1", "/activate all owner", { senderOpenId: "ou_owner", senderName: "Owner" }));
    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledWith("g1", "已激活群聊：Owner Room\n响应模式：all\nRole：owner"));
    expect(repository.findByConversationKey("group:oc_group")).toMatchObject({
      name: "Owner Room",
      responseMode: "all",
      role: "owner"
    });

    manager.submitIncoming(groupMessage("g2", "/activate at", { senderOpenId: "ou_owner", senderName: "Owner" }));
    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledWith("g2", "已激活群聊：Renamed Room\n响应模式：at\nRole：owner"));
    expect(repository.findByConversationKey("group:oc_group")).toMatchObject({
      name: "Renamed Room",
      responseMode: "at",
      role: "owner"
    });

    manager.submitIncoming(
      groupMessage("g3", "@_bot /activate all guest", {
        senderOpenId: "ou_owner",
        senderName: "Owner",
        mentions: [botMention()]
      })
    );
    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("g3", "该群已绑定 role=owner，本期不支持修改为 guest。")
    );
    expect(repository.findByConversationKey("group:oc_group")).toMatchObject({
      responseMode: "at",
      role: "owner"
    });
  });

  it("requires bot mentions in at-mode groups and strips the mention before parsing commands", async () => {
    const row = groupConversationRecord({ responseMode: "at" });
    const { repository } = createRepository(row);
    const lark = createLarkResponder();
    const codex = createCodex();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g1", "/status"));
    await waitForDelay();
    expect(repository.insertLarkMessage).not.toHaveBeenCalled();
    expect(lark.replyText).not.toHaveBeenCalled();

    manager.submitIncoming(groupMessage("g2", "@_bot /status", { mentions: [botMention()] }));
    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledWith("g2", expect.stringContaining("Response Mode: at")));
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "g2",
        routeKind: "control_message",
        text: "/status"
      })
    );
    expect(codex.startTurn).not.toHaveBeenCalled();

    manager.submitIncoming(
      groupMessage("g3", "@_bot /help", {
        senderOpenId: "ou_owner",
        senderName: "Owner",
        mentions: [botMention()]
      })
    );
    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledWith("g3", expect.stringContaining("/activate [all|at] [guest|owner]")));
    expect(lark.replyText).toHaveBeenCalledWith("g3", expect.stringContaining("/deactivate -"));
  });

  it("uses the shared group role and workspace for all-mode ordinary group messages", async () => {
    const row = groupConversationRecord({ responseMode: "all", role: "owner", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const manager = createManager({ repository, codex, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g1", "hello group"));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({ role: "owner", threadId: "thread_group", cwd: "/tmp/twinny/workspaces/group:oc_group" })
    );
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "owner",
        threadId: "thread_group",
        cwd: "/tmp/twinny/workspaces/group:oc_group",
        input: '<lark_message lark_message_id="g1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\nhello group\n</lark_message>'
      })
    );
  });

  it("treats none-mode groups as inactive until the owner activates them again", async () => {
    const row = groupConversationRecord({ responseMode: "none" });
    const { repository } = createRepository(row);
    const lark = createLarkResponder();
    const larkChats: LarkChatDirectory = {
      getChatName: vi.fn(async () => "Reenabled Room")
    };
    const manager = createManager({ repository, lark, larkChats, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g1", "@_bot hello", { mentions: [botMention()] }));
    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("g1", "群聊未授权，需要 owner 发送 /activate 激活。")
    );
    expect(repository.insertLarkMessage).not.toHaveBeenCalled();

    manager.submitIncoming(groupMessage("g2", "/activate all", { senderOpenId: "ou_owner", senderName: "Owner" }));
    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledWith("g2", "已激活群聊：Reenabled Room\n响应模式：all\nRole：guest"));
    expect(row).toMatchObject({ name: "Reenabled Room", responseMode: "all", role: "guest" });
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({ larkMessageId: "g2", routeKind: "control_message" })
    );
  });

  it("deactivates a group and stops active or queued work across that group", async () => {
    const row = groupConversationRecord({ responseMode: "all", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(groupMessage("g2", "/queue queued"));
    await waitForExpect(() => expect(manager.queueDepth("group:oc_group")).toBe(1));

    manager.submitIncoming(groupMessage("g3", "/deactivate", { senderOpenId: "ou_owner", senderName: "Owner" }));

    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledWith("g3", "已停用该群，清空 1 条待处理消息。"));
    expect(row.responseMode).toBe("none");
    expect(codex.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "guest", threadId: "thread_group", turnId: "turn_1" })
    );
    expect(repository.markLarkMessagesCleared).toHaveBeenCalledWith(["g2"]);
    expect(repository.markLarkMessagesInterrupted).toHaveBeenCalledWith(["g1"]);
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g3"]);

    turns[0]!.resolve(completed("thread_group", "turn_1", "interrupted"));
  });

  it("uses one group conversation and workspace but separate fresh Codex threads for topic threads", async () => {
    const row = groupConversationRecord({ type: "topic_group", responseMode: "all", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    const nextThreads = ["thread_topic_a", "thread_topic_b"];
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: nextThreads.shift() ?? "thread_extra" }))
    });
    const manager = createManager({ repository, codex, botOpenId: "ou_bot" });

    manager.submitIncoming(topicMessage("t1", "topic a first", "topic_a"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await waitForDelay();
    manager.submitIncoming(topicMessage("t2", "topic a second", "topic_a"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    await waitForDelay();
    manager.submitIncoming(topicMessage("t3", "topic b first", "topic_b"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(3));

    expect(codex.startThread).toHaveBeenCalledTimes(2);
    expect(codex.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread_topic_a", cwd: "/tmp/twinny/workspaces/group:oc_group" })
    );
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ threadId: "thread_topic_a", cwd: "/tmp/twinny/workspaces/group:oc_group" })
    );
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ threadId: "thread_topic_a", cwd: "/tmp/twinny/workspaces/group:oc_group" })
    );
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ threadId: "thread_topic_b", cwd: "/tmp/twinny/workspaces/group:oc_group" })
    );
    expect(repository.getCodexThreadByConversationAndLarkThread).toHaveBeenCalledWith("group:oc_group", "topic_a");
    expect(repository.upsertCodexThread).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "group:oc_group",
        codexThreadId: "thread_topic_a",
        larkThreadId: "topic_a"
      })
    );
    expect(repository.upsertCodexThread).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "group:oc_group",
        codexThreadId: "thread_topic_b",
        larkThreadId: "topic_b"
      })
    );
  });

  it("ignores duplicate message ids", async () => {
    const codex = createCodex();
    const manager = createManager({ codex });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m1", "first again"));
    await waitForDelay();

    expect(codex.startTurn).toHaveBeenCalledTimes(1);
  });

  it("ignores message ids already persisted in the local message table", async () => {
    const codex = createCodex();
    const { repository } = createRepository(undefined, { larkMessageIds: ["m1"] });
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(async ({ outputDir }) => ({
        path: `${outputDir}/report.txt`,
        resourceType: "file" as const,
        fileKey: "file_1",
        size: 123
      }))
    };
    const manager = createManager({ repository, codex, larkFiles });

    manager.submitIncoming(
      message("m1", "duplicate", {
        messageType: "file",
        resources: [{ resourceType: "file", fileKey: "file_1" }]
      })
    );
    await waitForDelay();

    expect(repository.getLarkMessageById).toHaveBeenCalledWith("m1");
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(larkFiles.downloadMessageResource).not.toHaveBeenCalled();
    expect(repository.insertLarkMessage).not.toHaveBeenCalled();
  });

  it("wraps Lark metadata and raw text before submitting to Codex", async () => {
    const codex = createCodex();
    const larkUsers: LarkUserDirectory = {
      getUserNameByOpenId: vi.fn(async () => 'Guest "User"')
    };
    const manager = createManager({ codex, larkUsers });

    manager.submitIncoming(
      message("m1", 'hello <codex> & "friend"', {
        createTime: 1700000000123,
        senderName: 'Guest "User"'
      })
    );

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input:
          '<lark_message lark_message_id="m1" timestamp="1700000000123" sender_ouid="ou_guest" sender_name="Guest &quot;User&quot;">\n' +
          'hello <codex> & "friend"\n' +
          "</lark_message>"
      })
    );
  });

  it("accepts parsed post messages without downloadable resources", async () => {
    const codex = createCodex();
    const manager = createManager({ codex });

    manager.submitIncoming(message("m1", "Parsed **post** body", { messageType: "post" }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input:
          '<lark_message lark_message_id="m1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
          "Parsed **post** body\n" +
          "</lark_message>"
      })
    );
  });

  it("resolves empty stored Lark sender names from the directory and includes them in Codex input", async () => {
    const codex = createCodex();
    const larkUsers: LarkUserDirectory = {
      getUserNameByOpenId: vi.fn(async () => "Resolved User")
    };
    const manager = createManager({ codex, larkUsers });

    manager.submitIncoming(
      message("m1", "hello", {
        senderName: "Event Name"
      })
    );

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(larkUsers.getUserNameByOpenId).toHaveBeenCalledWith("ou_guest");
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: '<lark_message lark_message_id="m1" timestamp="1234" sender_ouid="ou_guest" sender_name="Resolved User">\nhello\n</lark_message>'
      })
    );
  });

  it("reuses stored Lark sender names without calling the directory", async () => {
    const codex = createCodex();
    const { repository } = createRepository(conversationRecord({ name: "Stored User" }));
    const larkUsers: LarkUserDirectory = {
      getUserNameByOpenId: vi.fn(async () => "Directory User")
    };
    const manager = createManager({ repository, codex, larkUsers });

    manager.submitIncoming(message("m1", "hello", { senderName: "Event User" }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(larkUsers.getUserNameByOpenId).not.toHaveBeenCalled();
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: '<lark_message lark_message_id="m1" timestamp="1234" sender_ouid="ou_guest" sender_name="Stored User">\nhello\n</lark_message>'
      })
    );
  });

  it("caches failed Lark sender name lookups and omits sender_name from Codex input", async () => {
    const codex = createCodex();
    const larkUsers: LarkUserDirectory = {
      getUserNameByOpenId: vi.fn(async () => {
        throw new Error("contact unavailable");
      })
    };
    const manager = createManager({ codex, larkUsers });

    manager.submitIncoming(message("m1", "first", { senderName: "Event User" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "second", { senderName: "Event User" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));

    expect(larkUsers.getUserNameByOpenId).toHaveBeenCalledTimes(1);
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        input: '<lark_message lark_message_id="m1" timestamp="1234" sender_ouid="ou_guest">\nfirst\n</lark_message>'
      })
    );
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        input: '<lark_message lark_message_id="m2" timestamp="1234" sender_ouid="ou_guest">\nsecond\n</lark_message>'
      })
    );
  });

  it("downloads Lark file resources into the conversation workspace before submitting to Codex", async () => {
    const codex = createCodex();
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(async ({ outputDir }) => ({
        path: `${outputDir}/report.txt`,
        resourceType: "file" as const,
        fileKey: "file_1",
        fileName: "report.txt",
        size: 123,
        contentType: "text/plain"
      }))
    };
    const manager = createManager({ codex, larkFiles });

    manager.submitIncoming(
      message("m1", "placeholder", {
        messageType: "file",
        resources: [{ resourceType: "file", fileKey: "file_1", fileName: "report.txt" }]
      })
    );

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(larkFiles.downloadMessageResource).toHaveBeenCalledWith({
      messageId: "m1",
      resourceType: "file",
      fileKey: "file_1",
      fileName: "report.txt",
      outputDir: "/tmp/twinny/workspaces/p2p:ou_guest/.twinny/lark_files/m1"
    });
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input:
          '<lark_message lark_message_id="m1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
          '<file path="/tmp/twinny/workspaces/p2p:ou_guest/.twinny/lark_files/m1/report.txt" lark_file_key="file_1" size="123">Saved locally</file>\n' +
          "</lark_message>"
      })
    );
  });

  it("formats downloaded Lark video resources as XML file elements for Codex", async () => {
    const codex = createCodex();
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(async ({ outputDir }) => ({
        path: `${outputDir}/clip.mp4`,
        resourceType: "file" as const,
        fileKey: "file_1",
        fileName: "clip.mp4",
        size: 456,
        contentType: "video/mp4"
      }))
    };
    const manager = createManager({ codex, larkFiles });

    manager.submitIncoming(
      message("m1", "placeholder", {
        messageType: "video",
        resources: [{ resourceType: "file", fileKey: "file_1", fileName: "clip.mp4" }]
      })
    );

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input:
          '<lark_message lark_message_id="m1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
          '<video path="/tmp/twinny/workspaces/p2p:ou_guest/.twinny/lark_files/m1/clip.mp4" lark_file_key="file_1" size="456">Saved locally</video>\n' +
          "</lark_message>"
      })
    );
  });

  it("preserves post markdown while replacing downloaded media placeholders with XML elements", async () => {
    const codex = createCodex();
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(async ({ outputDir, resourceType, fileKey }) => ({
        path: `${outputDir}/${fileKey}${resourceType === "image" ? ".jpg" : ".mp4"}`,
        resourceType,
        fileKey,
        fileName: `${fileKey}${resourceType === "image" ? ".jpg" : ".mp4"}`,
        size: resourceType === "image" ? 111 : 222,
        contentType: resourceType === "image" ? "image/jpeg" : "video/mp4"
      }))
    };
    const manager = createManager({ codex, larkFiles });

    manager.submitIncoming(
      message("m1", "Please inspect\n\n{{TWINNY_LARK_RESOURCE_0}}\n\n{{TWINNY_LARK_RESOURCE_1}}", {
        messageType: "post",
        resources: [
          {
            resourceType: "image",
            fileKey: "img_1",
            codexTag: "img",
            textPlaceholder: "{{TWINNY_LARK_RESOURCE_0}}"
          },
          {
            resourceType: "file",
            fileKey: "file_1",
            codexTag: "video",
            textPlaceholder: "{{TWINNY_LARK_RESOURCE_1}}"
          }
        ]
      })
    );

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input:
          '<lark_message lark_message_id="m1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
          "Please inspect\n\n" +
          '<img path="/tmp/twinny/workspaces/p2p:ou_guest/.twinny/lark_files/m1/img_1.jpg" lark_file_key="img_1" size="111">Saved locally</img>\n\n' +
          '<video path="/tmp/twinny/workspaces/p2p:ou_guest/.twinny/lark_files/m1/file_1.mp4" lark_file_key="file_1" size="222">Saved locally</video>\n' +
          "</lark_message>"
      })
    );
  });

  it("forwards unsupported Lark message types to Codex with raw metadata", async () => {
    const codex = createCodex();
    const manager = createManager({ codex });
    const rawMessage = JSON.stringify({
      message_id: "m1",
      message_type: "merge_forward",
      content: JSON.stringify({ message_id_list: ["om_child"] })
    });

    manager.submitIncoming(
      message("m1", rawMessage, {
        messageType: "merge_forward",
        rawForCodex: true
      })
    );

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input:
          '<lark_message lark_message_id="m1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User" raw="true">\n' +
          `${rawMessage}\n` +
          "</lark_message>"
      })
    );
  });

  it("replaces a persisted thread when Codex no longer has the rollout", async () => {
    const row = conversationRecord({ codexThreadId: "thread_missing" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_replacement" })),
      resumeThread: vi.fn(async () => {
        throw new TwinnyError("no rollout found for thread id thread_missing", "CODEX_REQUEST_FAILED", {
          code: -32600,
          message: "no rollout found for thread id thread_missing"
        });
      }),
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({ id: "agent_1", text: "reply" });
        return completed(threadId, "turn_1");
      })
    });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyMarkdown).toHaveBeenCalledWith("m1", "reply"));

    expect(row.codexThreadId).toBe("thread_replacement");
    expect(codex.startTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread_replacement" }));
    expect(lark.replyText).toHaveBeenNthCalledWith(1, "m1", expect.stringMatching(/^WARN: .*previous context/));
  });

  it("sends completed agentMessage items and skips the turn-finished aggregate reply", async () => {
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({ id: "agent_1", text: "first item" });
        await onAgentMessage?.({ id: "agent_2", text: "second item" });
        return {
          threadId,
          turnId: "turn_1",
          text: "final aggregate should not be sent",
          status: "completed" as const
        };
      })
    });
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyMarkdown).toHaveBeenCalledTimes(2));
    await waitForExpect(() => expect(lark.addCompletedReaction).toHaveBeenCalledWith("reply_m1_2"));

    expect(lark.replyMarkdown).toHaveBeenNthCalledWith(1, "m1", "first item");
    expect(lark.replyMarkdown).toHaveBeenNthCalledWith(2, "m1", "second item");
    expect(lark.replyMarkdown).not.toHaveBeenCalledWith("m1", "final aggregate should not be sent");
    expect(lark.addCompletedReaction).toHaveBeenCalledTimes(1);
  });

  it("uploads SEND_TO_LARK image directives from completed agent messages and embeds them in the Lark post", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-send-image-"));
    const workspaceRoot = path.join(tempRoot, "workspaces");
    const workspace = path.join(workspaceRoot, "p2p:ou_guest");
    fs.mkdirSync(workspace, { recursive: true });
    const imagePath = path.join(workspace, "result.png");
    fs.writeFileSync(imagePath, "png");
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({
          id: "agent_1",
          text: `ready\nSEND_TO_LARK: <img path="${imagePath}"></img>\ndone`
        });
        return completed(threadId, "turn_1");
      })
    });
    const lark = createLarkResponder();
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(),
      uploadImage: vi.fn(async () => ({ imageKey: "img_uploaded" }))
    };
    const manager = createManager({ codex, lark, larkFiles, workspaceRoot });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyPost).toHaveBeenCalledTimes(1));

    expect(larkFiles.uploadImage).toHaveBeenCalledWith({
      filePath: imagePath,
      fileName: "result.png",
      contentType: "image/png"
    });
    expect(lark.replyPost).toHaveBeenCalledWith("m1", [
      [{ tag: "md", text: "ready" }],
      [{ tag: "img", image_key: "img_uploaded" }],
      [{ tag: "md", text: "done" }]
    ]);
    expect(lark.replyMarkdown).not.toHaveBeenCalledWith("m1", expect.stringContaining("SEND_TO_LARK"));
  });

  it("uploads SEND_TO_LARK files, shows the attachment line, and sends the file as a separate reply", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-send-file-"));
    const workspaceRoot = path.join(tempRoot, "workspaces");
    const workspace = path.join(workspaceRoot, "p2p:ou_guest");
    fs.mkdirSync(workspace, { recursive: true });
    const filePath = path.join(workspace, "report.txt");
    fs.writeFileSync(filePath, "report");
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({
          id: "agent_1",
          text: `see attachment\nSEND_TO_LARK: <file path="${filePath}"></file>`
        });
        return completed(threadId, "turn_1");
      })
    });
    const lark = createLarkResponder();
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(),
      uploadFile: vi.fn(async () => ({ fileKey: "file_uploaded" }))
    };
    const manager = createManager({ codex, lark, larkFiles, workspaceRoot });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyFile).toHaveBeenCalledWith("m1", "file_uploaded"));

    expect(larkFiles.uploadFile).toHaveBeenCalledWith({
      filePath,
      fileName: "report.txt",
      fileType: "stream",
      contentType: "text/plain"
    });
    expect(lark.replyPost).toHaveBeenCalledWith("m1", [[{ tag: "md", text: "see attachment\n📎 report.txt" }]]);
  });

  it("rejects SEND_TO_LARK symlinks whose real target is outside the workspace", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-send-link-"));
    const workspaceRoot = path.join(tempRoot, "workspaces");
    const workspace = path.join(workspaceRoot, "p2p:ou_guest");
    fs.mkdirSync(workspace, { recursive: true });
    const outsideFile = path.join(tempRoot, "outside.png");
    fs.writeFileSync(outsideFile, "png");
    const linkPath = path.join(workspace, "linked.png");
    fs.symlinkSync(outsideFile, linkPath);
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({ id: "agent_1", text: `SEND_TO_LARK: <img path="${linkPath}"></img>` });
        return completed(threadId, "turn_1");
      })
    });
    const lark = createLarkResponder();
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(),
      uploadImage: vi.fn(async () => ({ imageKey: "img_uploaded" }))
    };
    const manager = createManager({ codex, lark, larkFiles, workspaceRoot });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyPost).toHaveBeenCalledTimes(1));

    expect(larkFiles.uploadImage).not.toHaveBeenCalled();
    expect(lark.replyPost).toHaveBeenCalledWith("m1", [
      [{ tag: "md", text: "❌ 发送图片/视频/附件失败：真实文件不在 workspace 内" }]
    ]);
  });

  it("recovers processing messages by continuing their stored Codex thread", async () => {
    const row = conversationRecord({ codexThreadId: "thread_recovered" });
    const record = larkMessageRecord({
      larkMessageId: "m1",
      codexThreadId: "thread_recovered",
      status: "processing",
      rawEventJson: JSON.stringify(rawReceiveEvent("m1", "original message"))
    });
    const { repository } = createRepository(row, { larkMessages: [record] });
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    await manager.recoverUnfinishedMessages();
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    expect(codex.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread_recovered" }));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_recovered",
        input: "Twinny daemon has beed reloaded, continue with the unfinished work."
      })
    );
    expect(repository.markLarkMessagesProcessing).toHaveBeenCalledWith(["m1"], {
      conversationKey: "p2p:ou_guest",
      codexThreadId: "thread_recovered"
    });
  });

  it("recovers queued messages from raw Lark event JSON", async () => {
    const row = conversationRecord({ codexThreadId: "thread_recovered" });
    const record = larkMessageRecord({
      larkMessageId: "m2",
      routeKind: "queued_message",
      status: "queued",
      text: "queued from command",
      rawEventJson: JSON.stringify(rawReceiveEvent("m2", "/queue queued from command"))
    });
    const { repository } = createRepository(row, { larkMessages: [record] });
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    await manager.recoverUnfinishedMessages();
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_recovered",
        input:
          '<lark_message lark_message_id="m2" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
          "queued from command\n" +
          "</lark_message>"
      })
    );
  });

  it("recovers queued file messages from raw Lark event JSON and downloads resources", async () => {
    const row = conversationRecord({ codexThreadId: "thread_recovered" });
    const record = larkMessageRecord({
      larkMessageId: "m2",
      routeKind: "queued_message",
      status: "queued",
      text: "stale stored text",
      rawEventJson: JSON.stringify(
        rawReceiveEvent("m2", "", {
          message_type: "image",
          content: JSON.stringify({ image_key: "img_1" })
        })
      )
    });
    const { repository } = createRepository(row, { larkMessages: [record] });
    const codex = createCodex();
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(async ({ outputDir }) => ({
        path: `${outputDir}/img_1.png`,
        resourceType: "image" as const,
        fileKey: "img_1",
        fileName: "img_1.png",
        size: 789,
        contentType: "image/png"
      }))
    };
    const manager = createManager({ repository, codex, larkFiles });

    await manager.recoverUnfinishedMessages();
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    expect(larkFiles.downloadMessageResource).toHaveBeenCalledWith({
      messageId: "m2",
      resourceType: "image",
      fileKey: "img_1",
      fileName: undefined,
      outputDir: "/tmp/twinny/workspaces/p2p:ou_guest/.twinny/lark_files/m2"
    });
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input:
          '<lark_message lark_message_id="m2" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
          '<img path="/tmp/twinny/workspaces/p2p:ou_guest/.twinny/lark_files/m2/img_1.png" lark_file_key="img_1" size="789">Saved locally</img>\n' +
          "</lark_message>"
      })
    );
  });

  it("rejects new submissions during shutdown without clearing unfinished message state", async () => {
    const { codex } = createDeferredCodex();
    const lark = createLarkResponder();
    const { repository } = createRepository();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued"));
    await waitForExpect(() => expect(manager.queueDepth("p2p:ou_guest")).toBe(1));

    await manager.shutdown();

    expect(() => manager.submitIncoming(message("m3", "after shutdown"))).toThrow(/shutting down/);
    expect(codex.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "guest", threadId: "thread_1", turnId: "turn_1" })
    );
    expect(lark.replyText).not.toHaveBeenCalledWith("m1", expect.any(String));
    expect(lark.replyText).not.toHaveBeenCalledWith("m2", expect.any(String));
    expect(repository.markLarkMessagesFailed).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCleared).not.toHaveBeenCalled();
  });
});

function createManager(options: {
  repository?: ConversationRepository;
  codex?: CodexBridge;
  lark?: LarkResponder;
  larkUsers?: LarkUserDirectory;
  larkChats?: LarkChatDirectory;
  larkFiles?: LarkFileDownloader;
  larkMessages?: LarkMessageReader;
  botOpenId?: string;
  workspaceRoot?: string;
  logger?: ConstructorParameters<typeof ConversationManager>[0]["logger"];
} = {}): ConversationManager {
  const workspaceRoot = options.workspaceRoot ?? "/tmp/twinny/workspaces";
  return new ConversationManager({
    config,
    repository: options.repository ?? createRepository().repository,
    workspaces: {
      ensureWorkspace: (key) => path.join(workspaceRoot, key)
    },
    roles: {
      codexHomeFor: (role) => config.roles[role].codexHome
    },
    codex: options.codex ?? createCodex(),
    lark: options.lark ?? createLarkResponder(),
    larkUsers: options.larkUsers ?? createLarkUserDirectory(),
    larkChats: options.larkChats,
    larkFiles: options.larkFiles,
    larkMessages: options.larkMessages,
    botOpenId: options.botOpenId,
    logger: options.logger,
    nameLookupFailureTtlMs: 60_000
  });
}

function createLarkUserDirectory(): LarkUserDirectory {
  return {
    getUserNameByOpenId: vi.fn(async () => "Guest User")
  };
}

function createLarkMessageReader(messages: Record<string, unknown> | Error): LarkMessageReader {
  return {
    getMessage: vi.fn(async (messageId: string) => {
      if (messages instanceof Error) {
        throw messages;
      }
      const message = messages[messageId];
      if (!message) {
        throw new Error(`missing test message ${messageId}`);
      }
      return message;
    })
  };
}

function createLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
  return logger as typeof logger & Logger;
}

function createCodex(overrides: Partial<CodexBridge> = {}): CodexBridge {
  return {
    startThread: vi.fn(async () => ({ threadId: "thread_1" })),
    resumeThread: vi.fn(async ({ threadId }) => ({ threadId })),
    startTurn: vi.fn(async ({ threadId, onTurnStarted }) => {
      await onTurnStarted?.("turn_1");
      return completed(threadId, "turn_1");
    }),
    steerTurn: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
    readAccountRateLimits: vi.fn(async () => ({
      rateLimits: {
        primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1778946000 },
        secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1779550800 }
      },
      rateLimitsByLimitId: null
    })),
    ...overrides
  };
}

function createDeferredCodex(): {
  codex: CodexBridge;
  turns: Array<Deferred<CodexTurnResult> & { params: Parameters<CodexBridge["startTurn"]>[0] }>;
} {
  const turns: Array<Deferred<CodexTurnResult> & { params: Parameters<CodexBridge["startTurn"]>[0] }> = [];
  const codex = createCodex({
    startTurn: vi.fn((params) => {
      const turn = deferred<CodexTurnResult>();
      turns.push({ ...turn, params });
      void params.onTurnStarted?.(`turn_${turns.length}`);
      return turn.promise;
    })
  });
  return { codex, turns };
}

function createLarkResponder(): LarkResponder {
  let markdownReplyCount = 0;
  return {
    addTypingReaction: vi.fn(async (messageId) => ({ messageId, reactionId: `r_${messageId}` })),
    addCompletedReaction: vi.fn(async (messageId) => ({ messageId, reactionId: `done_${messageId}` })),
    removeReaction: vi.fn(async () => undefined),
    replyText: vi.fn(async () => undefined),
    replyMarkdown: vi.fn(async (messageId) => ({ messageId: `reply_${messageId}_${++markdownReplyCount}` })),
    replyPost: vi.fn(async (messageId) => ({ messageId: `reply_${messageId}_${++markdownReplyCount}` })),
    replyFile: vi.fn(async (messageId) => ({ messageId: `reply_${messageId}_${++markdownReplyCount}` })),
    sendTextToOpenId: vi.fn(async () => undefined)
  };
}

function createRepository(initial?: ConversationRecord, options: {
  larkMessageIds?: string[];
  larkMessages?: LarkMessageRecord[];
  codexThreads?: CodexThreadRecord[];
} = {}): {
  repository: ConversationRepository;
  row: ConversationRecord | undefined;
} {
  let row = initial;
  const larkMessageIds = new Set(options.larkMessageIds ?? []);
  const larkMessages = new Map<string, LarkMessageRecord>();
  const codexThreads = new Map<string, CodexThreadRecord>();
  let nextCodexThreadId = 1;
  for (const record of options.larkMessages ?? []) {
    larkMessageIds.add(record.larkMessageId);
    larkMessages.set(record.larkMessageId, record);
  }
  for (const thread of options.codexThreads ?? []) {
    codexThreads.set(thread.codexThreadId, thread);
    nextCodexThreadId = Math.max(nextCodexThreadId, thread.id + 1);
  }
  const getCodexThreadByLarkThread = (conversationKey: string, larkThreadId: string) =>
    [...codexThreads.values()].find(
      (thread) => thread.conversationKey === conversationKey && thread.larkThreadId === larkThreadId
    );
  const putCodexThread = (input: {
    codexThreadId: string;
    conversationKey: string;
    role: "owner" | "guest";
    larkThreadId?: string;
  }): CodexThreadRecord => {
    const existing = codexThreads.get(input.codexThreadId);
    const record: CodexThreadRecord = {
      id: existing?.id ?? nextCodexThreadId++,
      codexThreadId: input.codexThreadId,
      conversationKey: input.conversationKey,
      larkThreadId: input.larkThreadId ?? existing?.larkThreadId,
      role: input.role,
      totalTokens: existing?.totalTokens ?? 0,
      tokenUsageJson: existing?.tokenUsageJson ?? "{}",
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    };
    codexThreads.set(record.codexThreadId, record);
    return record;
  };
  const replaceCodexThreadForLarkThread = (
    conversationKey: string,
    larkThreadId: string,
    update: { codexThreadId: string; role: "owner" | "guest" }
  ): CodexThreadRecord => {
    const existing = getCodexThreadByLarkThread(conversationKey, larkThreadId);
    if (existing) {
      codexThreads.delete(existing.codexThreadId);
    }
    const record: CodexThreadRecord = {
      id: existing?.id ?? nextCodexThreadId++,
      codexThreadId: update.codexThreadId,
      conversationKey,
      larkThreadId,
      role: update.role,
      totalTokens: 0,
      tokenUsageJson: "{}",
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    };
    codexThreads.set(record.codexThreadId, record);
    return record;
  };
  if (row) {
    putCodexThread({
      codexThreadId: row.codexThreadId,
      conversationKey: row.conversationKey,
      role: row.role
    });
  }
  return {
    get row() {
      return row;
    },
    repository: {
      findByConversationKey: () => row ?? null,
      getCodexThreadById: vi.fn((codexThreadId) =>
        codexThreads.get(codexThreadId) ?? {
          id: nextCodexThreadId++,
          codexThreadId,
          conversationKey: row?.conversationKey ?? "p2p:ou_guest",
          role: row?.role ?? "guest",
          totalTokens: 0,
          tokenUsageJson: "{}",
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ),
      getCodexThreadByConversationAndLarkThread: vi.fn(getCodexThreadByLarkThread),
      getLarkMessageById: vi.fn((larkMessageId) =>
        larkMessages.get(larkMessageId) ?? (larkMessageIds.has(larkMessageId) ? { larkMessageId } : undefined)
      ),
      listUnfinishedLarkMessages: vi.fn(() => [...larkMessages.values()].filter((message) =>
        message.status === "processing" || message.status === "queued"
      )),
      create: (record) => {
        row = {
          id: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...record,
          responseMode: record.responseMode ?? (record.type === "p2p" ? "all" : "none"),
          codexThreadHasRollout: record.codexThreadHasRollout ?? true
        };
        return row;
      },
      updateThreadBinding: (_key, update) => {
        if (!row) {
          throw new Error("missing conversation");
        }
        Object.assign(row, update, { updatedAt: Date.now() });
        return row;
      },
      updateConversationSettings: (_key, update) => {
        if (!row) {
          throw new Error("missing conversation");
        }
        Object.assign(row, update, { updatedAt: Date.now() });
        return row;
      },
      markThreadHasRollout: (_key, codexThreadId) => {
        if (row?.codexThreadId === codexThreadId) {
          row.codexThreadHasRollout = true;
          row.updatedAt = Date.now();
        }
      },
      upsertCodexThread: vi.fn(putCodexThread),
      replaceCodexThreadForLarkThread: vi.fn(replaceCodexThreadForLarkThread),
      updateCodexThreadTokenUsage: vi.fn(),
      insertLarkMessage: vi.fn((input) => {
        const record = larkMessageRecord({
          larkMessageId: input.larkMessageId,
          eventId: input.eventId,
          larkUserId: input.larkUserId,
          larkGroupId: input.larkGroupId,
          larkThreadId: input.larkThreadId,
          conversationKey: input.conversationKey,
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId,
          routeKind: input.routeKind,
          status: input.status,
          text: input.text,
          larkCreateTime: input.larkCreateTime,
          rawEventJson: input.rawEventJson
        });
        larkMessageIds.add(input.larkMessageId);
        larkMessages.set(input.larkMessageId, record);
        return record;
      }),
      markLarkMessageQueued: vi.fn(),
      markLarkMessageRecalled: vi.fn((larkMessageId) => {
        const existing = larkMessages.get(larkMessageId);
        if (!existing || existing.status !== "queued") {
          return false;
        }
        existing.status = "recalled";
        existing.updatedAt = Date.now();
        return true;
      }),
      updateQueuedLarkMessage: vi.fn((larkMessageId, update) => {
        const existing = larkMessages.get(larkMessageId);
        if (!existing || existing.status !== "queued") {
          return false;
        }
        existing.text = update.text;
        existing.rawEventJson = update.rawEventJson ?? existing.rawEventJson;
        existing.updatedAt = Date.now();
        return true;
      }),
      markLarkMessagesProcessing: vi.fn(),
      markLarkMessagesSteered: vi.fn(),
      markLarkMessagesCompleted: vi.fn(),
      markLarkMessagesFailed: vi.fn(),
      markLarkMessagesInterrupted: vi.fn(),
      markLarkMessagesCleared: vi.fn()
    }
  };
}

function conversationRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 1,
    conversationKey: "p2p:ou_guest",
    type: "p2p",
    chatId: "ou_guest",
    name: "Guest User",
    responseMode: "all",
    role: "guest",
    codexThreadId: "thread_1",
    codexThreadHasRollout: true,
    workspace: "/tmp/twinny/workspaces/p2p:ou_guest",
    roleCodexHome: "/tmp/twinny/roles/guest/codex",
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  };
}

function groupConversationRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return conversationRecord({
    conversationKey: "group:oc_group",
    type: "group",
    chatId: "oc_group",
    name: "Team Room",
    responseMode: "all",
    codexThreadId: "thread_group",
    workspace: "/tmp/twinny/workspaces/group:oc_group",
    ...overrides
  });
}

function larkMessageRecord(overrides: Partial<LarkMessageRecord> = {}): LarkMessageRecord {
  const larkMessageId = overrides.larkMessageId ?? "m1";
  return {
    id: 1,
    larkMessageId,
    eventId: `e_${larkMessageId}`,
    larkUserId: "ou_guest",
    conversationKey: "p2p:ou_guest",
    routeKind: "message",
    status: "processing",
    text: "hello",
    larkCreateTime: 1234,
    receivedAt: 100,
    updatedAt: 100,
    rawEventJson: JSON.stringify(rawReceiveEvent(larkMessageId, "hello")),
    ...overrides
  };
}

function message(messageId: string, text: string, overrides: Partial<IncomingLarkMessage> = {}): IncomingLarkMessage {
  return {
    eventId: `e_${messageId}`,
    messageId,
    chatId: "oc_ignored",
    chatType: "p2p",
    messageType: "text",
    senderOpenId: "ou_guest",
    senderName: "Guest User",
    text,
    createTime: 1234,
    raw: {},
    ...overrides
  };
}

function botMenuAction(eventId: string, action: IncomingLarkBotMenuAction["action"]): IncomingLarkBotMenuAction {
  return {
    eventId,
    eventKey: action,
    action,
    operatorOpenId: "ou_guest",
    operatorName: "Guest User",
    timestamp: 1234,
    raw: {
      header: { event_id: eventId },
      event: {
        operator: {
          operator_name: "Guest User",
          operator_id: { open_id: "ou_guest" }
        },
        event_key: action,
        timestamp: 1234
      }
    }
  };
}

function groupMessage(messageId: string, text: string, overrides: Partial<IncomingLarkMessage> = {}): IncomingLarkMessage {
  return message(messageId, text, {
    chatId: "oc_group",
    chatType: "group",
    larkGroupId: "oc_group",
    ...overrides
  });
}

function topicMessage(
  messageId: string,
  text: string,
  larkThreadId: string,
  overrides: Partial<IncomingLarkMessage> = {}
): IncomingLarkMessage {
  return groupMessage(messageId, text, {
    chatType: "topic_group",
    larkThreadId,
    ...overrides
  });
}

function botMention(): NonNullable<IncomingLarkMessage["mentions"]>[number] {
  return {
    key: "@_bot",
    openId: "ou_bot",
    name: "Twinny"
  };
}

function rawReceiveEvent(messageId: string, text: string, messageOverrides: Record<string, unknown> = {}) {
  return {
    event_id: `e_${messageId}`,
    sender: {
      sender_id: {
        open_id: "ou_guest"
      },
      sender_type: "user"
    },
    message: {
      message_id: messageId,
      create_time: "1234",
      chat_id: "oc_ignored",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text }),
      ...messageOverrides
    }
  };
}

function fetchedLarkMessage(messageId: string, messageType: string, content: string) {
  return {
    message_id: messageId,
    msg_type: messageType,
    create_time: "1234",
    chat_id: "oc_ignored",
    chat_type: "p2p",
    body: {
      content
    }
  };
}

function wrappedMessage(text: string, messageId = "m1"): string {
  return `<lark_message lark_message_id="${messageId}" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n${text}\n</lark_message>`;
}

function completed(
  threadId: string,
  turnId: string,
  status: CodexTurnResult["status"] = "completed"
): CodexTurnResult {
  return {
    threadId,
    turnId,
    text: "",
    status
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitForExpect(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await waitForDelay();
    }
  }
  throw lastError;
}

function waitForDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
