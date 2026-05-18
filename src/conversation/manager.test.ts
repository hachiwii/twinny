import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { TwinnyError } from "../errors.js";
import { LarkMessageUnavailableError } from "../lark/messages.js";
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
    queuedReaction: "OneSecond",
    maxMessageAgeSeconds: 60,
    agentMessageMode: "plain"
  },
  owner: { openId: "ou_owner", displayName: "Owner" },
  roles: {
    owner: { codexHome: "/tmp/twinny/roles/owner/codex" },
    guest: { codexHome: "/tmp/twinny/roles/guest/codex" }
  }
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
        conversationKey: "p2p_ou_guest",
        routeKind: "message",
        status: "processing",
        text: "hello",
        larkCreateTime: 1234
      })
    );
    expect(repository.upsertCodexThread).toHaveBeenCalledWith({
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_1",
      role: "guest",
      larkThreadId: undefined
    });
    expect(repository.markLarkMessagesProcessing).toHaveBeenCalledWith(["m1"], {
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_1"
    });
    expect(repository.markLarkMessagesProcessing).toHaveBeenCalledWith(["m1"], {
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_1",
      codexTurnId: "turn_1"
    });
    expect(repository.updateCodexThreadTokenUsage).toHaveBeenCalledWith({
      codexThreadId: "thread_1",
      conversationKey: "p2p_ou_guest",
      role: "guest",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 42,
      contextTokens: 0,
      contextWindow: 0,
      tokenUsageJson: JSON.stringify({
        threadId: "thread_1",
        turnId: "turn_1",
        usage: { total: { totalTokens: 42 } }
      })
    });
  });

  it("adds the active turn duration when token usage refreshes a bound thread card", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const turn = deferred<CodexTurnResult>();
    let turnParams: Parameters<CodexBridge["startTurn"]>[0] | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const codex = createCodex({
      startTurn: vi.fn((params) => {
        turnParams = params;
        void params.onTurnStarted?.("turn_1");
        resolveStarted();
        return turn.promise;
      })
    });
    const { repository } = createRepository(undefined, {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_1",
          conversationKey: "p2p_ou_guest",
          cardMessageId: "card_thread_1"
        })
      ],
      larkMessages: [
        larkMessageRecord({
          larkMessageId: "m_old",
          codexThreadId: "thread_1",
          codexTurnId: "turn_old",
          status: "completed",
          processingStartedAt: 100,
          completedAt: 2_100
        })
      ]
    });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });
    let startTimeout: NodeJS.Timeout | undefined;

    try {
      manager.submitIncoming(message("m1", "hello"));
      await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          startTimeout = setTimeout(() => reject(new Error("timed out waiting for startTurn")), 1_000);
        })
      ]);
      if (startTimeout) {
        clearTimeout(startTimeout);
        startTimeout = undefined;
      }

      now = 6_000;
      await turnParams?.onTokenUsage?.({
        threadId: "thread_1",
        turnId: "turn_1",
        totalTokens: 42,
        raw: {
          threadId: "thread_1",
          turnId: "turn_1",
          usage: { total: { totalTokens: 42 } }
        }
      });

      const summaryCard = vi.mocked(lark.patchCard).mock.calls.find(([messageId]) => messageId === "card_thread_1")?.[1];
      expect(summaryCard).toBeDefined();
      const serialized = JSON.stringify(summaryCard);
      expect(serialized).toContain("Total Token");
      expect(serialized).toContain("42");
      expect(serialized).toContain("总工作时间");
      expect(serialized).toContain("7s");
    } finally {
      if (startTimeout) {
        clearTimeout(startTimeout);
      }
      turn.resolve(completed("thread_1", "turn_1"));
      await turn.promise;
      await waitForDelay();
      nowSpy.mockRestore();
    }
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
        conversationKey: "p2p_ou_guest",
        codexThreadId: "thread_1",
        codexTurnId: "turn_1"
      })
    );
    expect(repository.markLarkMessagesSteered).toHaveBeenCalledWith(["m1"], {
      conversationKey: "p2p_ou_guest",
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
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(2));

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

  it("adds queued reactions to waiting /queue and following ordinary messages, then clears them when consumed", async () => {
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued"));
    manager.submitIncoming(message("m3", "second queued"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(2));

    await waitForExpect(() => expect(lark.addQueuedReaction).toHaveBeenCalledTimes(2));
    expect(lark.addQueuedReaction).toHaveBeenNthCalledWith(1, "m2");
    expect(lark.addQueuedReaction).toHaveBeenNthCalledWith(2, "m3");

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(lark.removeReaction).toHaveBeenCalledWith({ messageId: "m2", reactionId: "queued_m2" });
    expect(lark.removeReaction).toHaveBeenCalledWith({ messageId: "m3", reactionId: "queued_m3" });

    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("does not add a queued reaction when /queue can start immediately", async () => {
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark });

    manager.submitIncoming(message("m1", "/queue immediate"));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(lark.addQueuedReaction).not.toHaveBeenCalled();
    expect(lark.addTypingReaction).toHaveBeenCalledWith("m1");

    turns[0]!.resolve(completed("thread_1", "turn_1"));
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
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(4));

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: `${wrappedMessage("1", "m2")}\n${wrappedMessage("2", "m3")}` })
    );
    expect(manager.queueDepth("p2p_ou_guest")).toBe(2);

    turns[1]!.resolve(completed("thread_1", "turn_2"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(3));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ input: wrappedMessage("3", "m4") })
    );
    expect(manager.queueDepth("p2p_ou_guest")).toBe(1);

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
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));
    await waitForExpect(() => expect(repository.insertLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      larkMessageId: "m2",
      status: "queued"
    })));
    await waitForExpect(() => expect(lark.addQueuedReaction).toHaveBeenCalledWith("m2"));

    manager.submitMessageRecall({ eventId: "recall_1", messageId: "m2", raw: {} });

    await waitForExpect(() => expect(repository.markLarkMessageRecalled).toHaveBeenCalledWith("m2"));
    expect(lark.removeReaction).toHaveBeenCalledWith({ messageId: "m2", reactionId: "queued_m2" });
    expect(manager.queueDepth("p2p_ou_guest")).toBe(0);

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
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(2));
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

  it("marks unavailable queued messages recalled before processing and skips them", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const larkMessages = createLarkMessageReader({
      m2: new LarkMessageUnavailableError("m2"),
      m3: fetchedLarkMessage("m3", "text", JSON.stringify({ text: "steer stored" }))
    });
    const manager = createManager({ repository, codex, larkMessages });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued", { raw: rawReceiveEvent("m2", "/queue queued") }));
    manager.submitIncoming(message("m3", "steer stored", { raw: rawReceiveEvent("m3", "steer stored") }));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(2));

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(larkMessages.getMessage).toHaveBeenCalledWith("m2");
    expect(larkMessages.getMessage).toHaveBeenCalledWith("m3");
    expect(repository.markLarkMessageRecalled).toHaveBeenCalledWith("m2");
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: wrappedMessage("steer stored", "m3") })
    );

    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("continues to the next queued batch when the whole refreshed batch was recalled", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const larkMessages = createLarkMessageReader({
      m2: new LarkMessageUnavailableError("m2"),
      m3: fetchedLarkMessage("m3", "text", JSON.stringify({ text: "/queue next" }))
    });
    const manager = createManager({ repository, codex, larkMessages });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue recalled", { raw: rawReceiveEvent("m2", "/queue recalled") }));
    manager.submitIncoming(message("m3", "/queue next", { raw: rawReceiveEvent("m3", "/queue next") }));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(2));

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(repository.markLarkMessageRecalled).toHaveBeenCalledWith("m2");
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: wrappedMessage("next", "m3") })
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
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));

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
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));
    await waitForExpect(() => expect(lark.addQueuedReaction).toHaveBeenCalledWith("m2"));
    manager.submitIncoming(message("m3", "/stop"));

    await waitForExpect(() => expect(repository.markLarkMessagesCleared).toHaveBeenCalledWith(["m2"]));
    expect(lark.removeReaction).toHaveBeenCalledWith({ messageId: "m2", reactionId: "queued_m2" });
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
    vi.mocked(repository.getCodexThreadById).mockReturnValue(codexThreadRecord({
      id: 1,
      codexThreadId: "thread_status",
      conversationKey: "p2p_ou_guest",
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
    }));
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(message("m1", "/status"));

    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledTimes(1));
    expect(lark.replyText).toHaveBeenCalledWith(
      "m1",
      [
        "OUID: ou_guest",
        "Conversation Key: p2p_ou_guest",
        "Codex Thread ID: thread_status",
        "Thread Token Usage:",
        "- total: 100",
        "- input: 80",
        "- output: 20",
        "- cached input: 40",
        "- reasoning output: 5",
        "- cache hit rate: 50.00%",
        "- context: 0 / 0 (0.00%)"
      ].join("\n")
    );
    expect(codex.readAccountRateLimits).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m1"]);
  });

  it("includes account usage windows in /status for the owner", async () => {
    const row = conversationRecord({
      conversationKey: "p2p_ou_owner",
      chatId: "ou_owner",
      role: "owner",
      codexThreadId: "thread_owner"
    });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(message("m1", "/status", { senderOpenId: "ou_owner", senderName: "Owner" }));

    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledTimes(1));
    expect(codex.readAccountRateLimits).toHaveBeenCalledWith({ role: "owner" });
    expect(lark.replyText).toHaveBeenCalledWith("m1", expect.stringContaining("Conversation Key: p2p_ou_owner"));
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
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));
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
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(2));

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
    expect(manager.queueDepth("p2p_ou_guest")).toBe(1);
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
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(3));

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
    expect(manager.queueDepth("p2p_ou_guest")).toBe(1);
    expect(repository.markLarkMessagesSteered).toHaveBeenCalledWith(["m1"], {
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_1",
      codexTurnId: "turn_1"
    });
    expect(repository.markLarkMessagesProcessing).toHaveBeenCalledWith(["m2", "m3"], {
      conversationKey: "p2p_ou_guest",
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
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(2));

    manager.submitIncoming(message("m4", "/steer"));
    await waitForExpect(() => expect(codex.steerTurn).toHaveBeenCalledTimes(1));

    expect(manager.queueDepth("p2p_ou_guest")).toBe(2);
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
    expect(manager.queueDepth("p2p_ou_guest")).toBe(1);

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: wrappedMessage("queued by menu", "m3") })
    );
    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("records bot menu events as menu actions and dedupes them by event id", async () => {
    const { repository } = createRepository();
    const lark = createLarkResponder();
    const manager = createManager({ repository, lark });

    manager.submitBotMenuAction(botMenuAction("menu-dup", "queue"));
    await waitForExpect(() => expect(lark.sendTextToOpenId).toHaveBeenCalledTimes(1));
    manager.submitBotMenuAction(botMenuAction("menu-dup", "queue"));
    await waitForDelay();

    expect(lark.sendTextToOpenId).toHaveBeenCalledTimes(1);
    const menuActionInputs = vi
      .mocked(repository.insertLarkMessage)
      .mock.calls
      .map(([input]) => input)
      .filter((input) => input.routeKind === "menu_action");
    expect(menuActionInputs).toHaveLength(1);
    expect(menuActionInputs[0]).toMatchObject({
      eventId: "menu-dup",
      larkUserId: "ou_guest",
      conversationKey: "p2p_ou_guest",
      routeKind: "menu_action",
      status: "completed",
      text: "queue",
      rawEventJson: JSON.stringify(botMenuAction("menu-dup", "queue").raw)
    });
    expect(menuActionInputs[0]).not.toHaveProperty("larkMessageId");
  });

  it("handles bot menu status and help as direct p2p replies", async () => {
    const row = conversationRecord({ codexThreadId: "thread_status" });
    const { repository } = createRepository(row);
    vi.mocked(repository.getCodexThreadById).mockReturnValue(codexThreadRecord({
      id: 1,
      codexThreadId: "thread_status",
      conversationKey: "p2p_ou_guest",
      role: "guest",
      totalTokens: 10,
      tokenUsageJson: JSON.stringify({ usage: { total: { totalTokens: 10 } } }),
      createdAt: 100,
      updatedAt: 100
    }));
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitBotMenuAction(botMenuAction("menu-status", "status"));
    manager.submitBotMenuAction(botMenuAction("menu-help", "help"));

    await waitForExpect(() => expect(lark.sendTextToOpenId).toHaveBeenCalledTimes(2));
    expect(lark.sendTextToOpenId).toHaveBeenCalledWith(
      "ou_guest",
      expect.stringContaining("Conversation Key: p2p_ou_guest")
    );
    expect(lark.sendTextToOpenId).toHaveBeenCalledWith("ou_guest", expect.stringContaining("Codex Thread ID: thread_status"));
    expect(lark.sendTextToOpenId).toHaveBeenCalledWith("ou_guest", expect.stringContaining("/help - 查看可用指令和使用说明"));
    expect(lark.replyText).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
  });

  it("creates a new topic card when the group new-session menu is clicked", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "all" });
    const { repository } = createRepository(row);
    const codex = createCodex({ startThread: vi.fn(async () => ({ threadId: "thread_new_session" })) });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitBotMenuAction(botMenuAction("menu-new-session", "new_session", {
      operatorOpenId: "ou_owner",
      operatorName: "Owner",
      chatId: "oc_group"
    }));

    await waitForExpect(() => expect(lark.sendCardToChatId).toHaveBeenCalledTimes(1));
    expect(codex.startThread).toHaveBeenCalledWith({
      role: "owner",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never"
    });
    expect(lark.sendCardToChatId).toHaveBeenCalledWith(
      "oc_group",
      expect.objectContaining({
        header: expect.objectContaining({
          template: "blue",
          title: { tag: "plain_text", content: "新会话" }
        })
      }),
      { uuid: expect.stringMatching(UUID_PATTERN) }
    );
    const sentCard = vi.mocked(lark.sendCardToChatId).mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(sentCard)).toContain("thread_new_session");
    expect(repository.updateCodexThreadCard).toHaveBeenLastCalledWith({
      conversationKey: "group_oc_group",
      codexThreadId: "thread_new_session",
      role: "owner",
      larkThreadId: "card_oc_group_1",
      creatorOpenId: "ou_owner",
      cardMessageId: "card_oc_group_1"
    });
  });

  it("keeps generated Lark uuid values within the OpenAPI limit for new-session cards", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "all" });
    const { repository } = createRepository(row);
    const codex = createCodex({ startThread: vi.fn(async () => ({ threadId: "thread_new_session" })) });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitBotMenuAction(botMenuAction(`event_${"x".repeat(100)}`, "new_session", {
      operatorOpenId: "ou_owner",
      operatorName: "Owner",
      chatId: "oc_group"
    }));

    await waitForExpect(() => expect(lark.sendCardToChatId).toHaveBeenCalledTimes(1));
    const options = vi.mocked(lark.sendCardToChatId).mock.calls[0]![2];
    expect(options?.uuid).toMatch(UUID_PATTERN);
    expect(options?.uuid).toHaveLength(36);
  });

  it("lets any group user create an empty thread card with /thread", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row);
    const codex = createCodex({ startThread: vi.fn(async () => ({ threadId: "thread_empty" })) });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_thread", "/thread", { senderOpenId: "ou_guest" }));

    await waitForExpect(() => expect(lark.sendCardToChatId).toHaveBeenCalledTimes(1));
    expect(codex.startThread).toHaveBeenCalledWith({
      role: "owner",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never"
    });
    expect(lark.sendCardToChatId).toHaveBeenCalledWith(
      "oc_group",
      expect.objectContaining({
        header: expect.objectContaining({
          template: "blue",
          title: { tag: "plain_text", content: "新会话" }
        })
      }),
      { uuid: expect.stringMatching(UUID_PATTERN) }
    );
    expect(repository.updateCodexThreadCard).toHaveBeenLastCalledWith({
      conversationKey: "group_oc_group",
      codexThreadId: "thread_empty",
      role: "owner",
      larkThreadId: "card_oc_group_1",
      creatorOpenId: "ou_guest",
      cardMessageId: "card_oc_group_1"
    });
    expect(lark.replyText).toHaveBeenCalledWith("card_oc_group_1", "新话题已创建");
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g_thread"]);
  });

  it("starts /thread initial text from the bot in-thread reply without resuming an empty card thread", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_initial" })),
      resumeThread: vi.fn(async ({ threadId }) => ({ threadId })),
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
    const lark = createLarkResponder();
    const cardMessageId = "card_oc_group_1";
    const cardThreadId = "topic_thread_1";
    vi.mocked(lark.sendCardToChatId).mockResolvedValueOnce({
      messageId: cardMessageId,
      raw: { data: { thread_id: cardThreadId } }
    });
    vi.mocked(lark.replyText).mockResolvedValueOnce({ messageId: "reply_thread_1" });
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g_thread", "/thread topic first", {
      senderOpenId: "ou_guest",
      senderName: "Guest User"
    }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await waitForExpect(() =>
      expect(repository.updateCodexThreadCard).toHaveBeenCalledWith({
        conversationKey: "group_oc_group",
        codexThreadId: "thread_initial",
        role: "owner",
        larkThreadId: cardThreadId,
        creatorOpenId: "ou_guest",
        cardMessageId: "card_oc_group_1"
      })
    );
    expect(lark.replyText).toHaveBeenCalledWith(cardMessageId, "topic first");
    expect(codex.resumeThread).not.toHaveBeenCalled();
    expect(codex.startThread).toHaveBeenCalledTimes(1);
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_initial",
        input: wrappedMessage("topic first", "reply_thread_1", "ou_guest")
      })
    );
    expect(repository.getCodexThreadByConversationAndLarkThread).toHaveBeenCalledWith("group_oc_group", cardThreadId);
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "reply_thread_1",
        eventId: "thread_reply:e_g_thread",
        larkUserId: "ou_guest",
        larkGroupId: "oc_group",
        larkThreadId: cardThreadId,
        conversationKey: "group_oc_group",
        routeKind: "message",
        status: "processing",
        text: "topic first"
      })
    );
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g_thread"]);
    await waitForExpect(() =>
      expect(lark.patchCard).toHaveBeenCalledWith(
        cardMessageId,
        expect.objectContaining({
          header: expect.objectContaining({
            title: { tag: "plain_text", content: "新会话" }
          })
        })
      )
    );

    await waitForDelay();
    manager.submitIncoming(groupMessage("g_topic_msg_2", "@_bot topic second", {
      senderOpenId: "ou_owner",
      chatType: "topic_group",
      larkThreadId: cardThreadId,
      mentions: [botMention()]
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.resumeThread).toHaveBeenCalledWith({
      role: "owner",
      threadId: "thread_initial",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never"
    });
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        threadId: "thread_initial",
        input: wrappedMessage("topic second", "g_topic_msg_2", "ou_owner")
      })
    );
  });

  it("rebuilds /thread text replies with send-side at mentions", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_text_mention" })),
      startTurn: vi.fn(async ({ threadId }) => completed(threadId, "turn_1"))
    });
    const lark = createLarkResponder();
    vi.mocked(lark.sendCardToChatId).mockResolvedValueOnce({
      messageId: "card_oc_group_1",
      raw: { data: { thread_id: "topic_thread_1" } }
    });
    vi.mocked(lark.replyText).mockResolvedValueOnce({ messageId: "reply_thread_1" });
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_thread_mention", "/thread hi @_user_1", {
      senderOpenId: "ou_guest",
      mentions: [{ key: "@_user_1", openId: "ou_alice", name: "Alice" }]
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(lark.replyText).toHaveBeenCalledWith(
      "card_oc_group_1",
      "hi <at user_id=\"ou_alice\">Alice</at>"
    );
    expect(lark.replyPost).not.toHaveBeenCalled();
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: wrappedMessage("hi @Alice", "reply_thread_1", "ou_guest")
      })
    );
  });

  it("rebuilds /thread post replies as send-side post content", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_post" })),
      startTurn: vi.fn(async ({ threadId }) => completed(threadId, "turn_1"))
    });
    const lark = createLarkResponder();
    vi.mocked(lark.sendCardToChatId).mockResolvedValueOnce({
      messageId: "card_oc_group_1",
      raw: { data: { thread_id: "topic_thread_1" } }
    });
    vi.mocked(lark.replyPost).mockResolvedValueOnce({ messageId: "reply_post_1" });
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_thread_post", "/thread post hi @_user_1\nsecond line", {
      messageType: "post",
      senderOpenId: "ou_guest",
      mentions: [{ key: "@_user_1", openId: "ou_alice", name: "Alice" }]
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(lark.replyText).not.toHaveBeenCalledWith("card_oc_group_1", expect.any(String));
    expect(lark.replyPost).toHaveBeenCalledWith("card_oc_group_1", [
      [
        { tag: "text", text: "post hi " },
        { tag: "at", user_id: "ou_alice", user_name: "Alice" }
      ],
      [{ tag: "text", text: "second line" }]
    ]);
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: wrappedMessage("post hi @Alice\nsecond line", "reply_post_1", "ou_guest")
      })
    );
  });

  it("rejects /thread forwarding from non-text and non-post messages", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_thread_image", "/thread image", {
      messageType: "image",
      senderOpenId: "ou_guest"
    }));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("g_thread_image", "thread 只支持 text/post 消息。")
    );
    expect(lark.sendCardToChatId).not.toHaveBeenCalled();
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g_thread_image"]);
  });

  it("rejects /thread inside Lark thread contexts", async () => {
    const row = groupConversationRecord({ responseMode: "all" });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_thread_nested", "/thread nested", {
      chatType: "topic_group",
      larkThreadId: "topic_thread_1"
    }));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("g_thread_nested", "不能在话题中使用此功能")
    );
    expect(lark.sendCardToChatId).not.toHaveBeenCalled();
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g_thread_nested"]);
  });

  it("rejects /thread outside group conversations", async () => {
    const row = conversationRecord({ role: "owner", chatId: "ou_owner", codexThreadId: "thread_owner" });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m_thread", "/thread hello", { senderOpenId: "ou_owner" }));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("m_thread", "thread 只能在群里用。")
    );
    expect(lark.sendCardToChatId).not.toHaveBeenCalled();
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m_thread"]);
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
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));
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
    await waitForExpect(() =>
      expect(repository.getCodexThreadById("thread_new")).toMatchObject({ codexThreadHasRollout: true })
    );

    turns[0]!.resolve(completed("thread_old", "turn_1", "interrupted"));
    turns[1]!.resolve(completed("thread_new", "turn_2"));
  });

  it("rejects /new inside Lark thread contexts", async () => {
    const row = groupConversationRecord({ responseMode: "all", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("t_new", "/new", { larkThreadId: "topic_a" }));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("t_new", "不能在话题内创建新的 Thread。")
    );
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(codex.interruptTurn).not.toHaveBeenCalled();
    expect(repository.replaceCodexThreadForLarkThread).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["t_new"]);
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
      getChatInfo: vi.fn(async () => ({ name: "Team Room", chatMode: "topic" as const }))
    };
    const manager = createManager({ repository, codex, lark, larkChats, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g1", "/activate", { senderOpenId: "ou_owner", senderName: "Owner" }));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith(
        "g1",
        expect.stringContaining("已激活群聊：Team Room\n响应模式：at\nRole：guest")
      )
    );
    expect(row).toBeUndefined();
    expect(repository.findByConversationKey("group_oc_group")).toBeDefined();
    expect(codex.startThread).toHaveBeenCalledWith({
      role: "guest",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never"
    });
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "g1",
        larkGroupId: "oc_group",
        conversationKey: "group_oc_group",
        routeKind: "control_message",
        text: "/activate"
      })
    );
    expect(repository.findByConversationKey("group_oc_group")).toMatchObject({
      conversationKey: "group_oc_group",
      type: "group",
      chatId: "oc_group",
      name: "Team Room",
      chatMode: "topic",
      responseMode: "at",
      role: "guest",
      workspace: "/tmp/twinny/workspaces/group_oc_group"
    });
  });

  it("keeps a group's first activated role immutable while allowing mode and name refreshes", async () => {
    const { repository } = createRepository();
    const lark = createLarkResponder();
    const larkChats: LarkChatDirectory = {
      getChatInfo: vi.fn()
        .mockResolvedValueOnce({ name: "Owner Room", chatMode: "topic" as const })
        .mockResolvedValueOnce({ name: "Renamed Room", chatMode: "group" as const })
    };
    const manager = createManager({ repository, lark, larkChats, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g1", "/activate all owner", { senderOpenId: "ou_owner", senderName: "Owner" }));
    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith(
        "g1",
        expect.stringContaining("已激活群聊：Owner Room\n响应模式：all\nRole：owner")
      )
    );
    expect(repository.findByConversationKey("group_oc_group")).toMatchObject({
      name: "Owner Room",
      chatMode: "topic",
      responseMode: "all",
      role: "owner"
    });

    manager.submitIncoming(groupMessage("g2", "/activate at", { senderOpenId: "ou_owner", senderName: "Owner" }));
    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith(
        "g2",
        expect.stringContaining("已激活群聊：Renamed Room\n响应模式：at\nRole：owner")
      )
    );
    expect(repository.findByConversationKey("group_oc_group")).toMatchObject({
      name: "Renamed Room",
      chatMode: "group",
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
    expect(repository.findByConversationKey("group_oc_group")).toMatchObject({
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
      expect.objectContaining({ role: "owner", threadId: "thread_group", cwd: "/tmp/twinny/workspaces/group_oc_group" })
    );
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "owner",
        threadId: "thread_group",
        cwd: "/tmp/twinny/workspaces/group_oc_group",
        input: '<lark_message lark_message_id="g1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\nhello group\n</lark_message>'
      })
    );
  });

  it("ignores unmentioned at-mode topic messages and still reuses thread on the next mention", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row);
    const thread = codexThreadRecord({
      codexThreadId: "thread_topic_1",
      larkThreadId: "topic_thread_1",
      conversationKey: "group_oc_group",
      role: "owner",
      creatorOpenId: "ou_owner"
    });
    const codex = createCodex({
      resumeThread: vi.fn(async ({ threadId }) => ({ threadId })),
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
        return completed(thread.codexThreadId, "turn_1");
      })
    });
    vi.spyOn(repository, "getCodexThreadByConversationAndLarkThread").mockReturnValue(thread);
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(
      groupMessage("g_topic_msg_no_mention", "topic first", {
        senderOpenId: "ou_owner",
        chatType: "topic_group",
        larkThreadId: "topic_thread_1"
      })
    );
    await waitForDelay();
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(codex.resumeThread).not.toHaveBeenCalled();
    expect(lark.replyText).not.toHaveBeenCalled();

    manager.submitIncoming(
      groupMessage("g_topic_msg_mention", "@_bot topic second", {
        senderOpenId: "ou_owner",
        chatType: "topic_group",
        larkThreadId: "topic_thread_1",
        mentions: [botMention()]
      })
    );
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.resumeThread).toHaveBeenCalledWith({
      role: "owner",
      threadId: "thread_topic_1",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never"
    });
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_topic_1",
        input: wrappedMessage("topic second", "g_topic_msg_mention", "ou_owner")
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
    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith(
        "g2",
        expect.stringContaining("已激活群聊：Reenabled Room\n响应模式：all\nRole：guest")
      )
    );
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
    await waitForExpect(() => expect(manager.queueDepth("group_oc_group")).toBe(1));

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

  it("uses one group conversation and workspace but separate fresh Codex threads for seen Lark thread ids", async () => {
    const row = groupConversationRecord({ responseMode: "all", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    const nextThreads = ["thread_topic_a", "thread_topic_b"];
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: nextThreads.shift() ?? "thread_extra" }))
    });
    const manager = createManager({ repository, codex, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("t1", "topic a first", { larkThreadId: "topic_a" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await waitForDelay();
    manager.submitIncoming(groupMessage("t2", "topic a second", { larkThreadId: "topic_a" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    await waitForDelay();
    manager.submitIncoming(groupMessage("t3", "topic b first", { larkThreadId: "topic_b" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(3));

    expect(codex.startThread).toHaveBeenCalledTimes(2);
    expect(codex.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread_topic_a", cwd: "/tmp/twinny/workspaces/group_oc_group" })
    );
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ threadId: "thread_topic_a", cwd: "/tmp/twinny/workspaces/group_oc_group" })
    );
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ threadId: "thread_topic_a", cwd: "/tmp/twinny/workspaces/group_oc_group" })
    );
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ threadId: "thread_topic_b", cwd: "/tmp/twinny/workspaces/group_oc_group" })
    );
    expect(repository.getCodexThreadByConversationAndLarkThread).toHaveBeenCalledWith("group_oc_group", "topic_a");
    expect(repository.upsertCodexThread).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "group_oc_group",
        codexThreadId: "thread_topic_a",
        larkThreadId: "topic_a"
      })
    );
    expect(repository.upsertCodexThread).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "group_oc_group",
        codexThreadId: "thread_topic_b",
        larkThreadId: "topic_b"
      })
    );
  });

  it("creates a separate Codex thread for any new thread id even in p2p conversations", async () => {
    const row = conversationRecord({ codexThreadId: "thread_p2p" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_dm_topic" }))
    });
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "dm threaded message", { larkThreadId: "dm_thread" }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.startThread).toHaveBeenCalledTimes(1);
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread_dm_topic", cwd: "/tmp/twinny/workspaces/p2p_ou_guest" })
    );
    expect(repository.getCodexThreadByConversationAndLarkThread).toHaveBeenCalledWith("p2p_ou_guest", "dm_thread");
    expect(repository.upsertCodexThread).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "p2p_ou_guest",
        codexThreadId: "thread_dm_topic",
        larkThreadId: "dm_thread"
      })
    );
  });

  it("ignores duplicate event ids", async () => {
    const codex = createCodex();
    const manager = createManager({ codex });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "first again", { eventId: "e_m1" }));
    await waitForDelay();

    expect(codex.startTurn).toHaveBeenCalledTimes(1);
  });

  it("ignores event ids already persisted in the local message table", async () => {
    const codex = createCodex();
    const { repository } = createRepository(undefined, {
      larkMessages: [larkMessageRecord({ larkMessageId: "proxy_m1", eventId: "e_m1" })]
    });
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

    expect(repository.getLarkMessageByEventId).toHaveBeenCalledWith("e_m1");
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
      outputDir: "/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m1"
    });
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input:
          '<lark_message lark_message_id="m1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
          '<file path="/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m1/report.txt" lark_file_key="file_1" size="123">Saved locally</file>\n' +
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
          '<video path="/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m1/clip.mp4" lark_file_key="file_1" size="456">Saved locally</video>\n' +
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
          '<img path="/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m1/img_1.jpg" lark_file_key="img_1" size="111">Saved locally</img>\n\n' +
          '<video path="/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m1/file_1.mp4" lark_file_key="file_1" size="222">Saved locally</video>\n' +
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

  it("creates an agent card immediately after sending input to Codex with an empty-progress placeholder", async () => {
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    const initialCard = vi.mocked(lark.replyCard).mock.calls[0]![1] as Record<string, unknown>;
    expect(lark.replyCard).toHaveBeenCalledWith("m1", expect.any(Object));
    expect(JSON.stringify(initialCard)).toContain("暂无进度");

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() =>
      expect(lark.replyCard).toHaveBeenNthCalledWith(
        2,
        "m1",
        expect.objectContaining({
          header: expect.objectContaining({
            template: "green",
            title: { tag: "plain_text", content: "已完成" }
          })
        })
      )
    );
    const finalCard = vi.mocked(lark.replyCard).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(JSON.stringify(finalCard)).not.toContain("工作过程");
    expect(lark.recallMessage).toHaveBeenCalledWith("card_m1_1");
  });

  it("updates the working agent card footer with model and thread token usage", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-codex-config-"));
    const codexHome = path.join(tempRoot, "codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "xhigh"',
      ""
    ].join("\n"));
    const managerConfig: TwinnyConfig = {
      ...cardModeConfig(),
      roles: {
        ...config.roles,
        guest: { codexHome }
      }
    };
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, config: managerConfig });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    await turns[0]!.params.onTokenUsage?.({
      threadId: "thread_1",
      turnId: "turn_1",
      totalTokens: 328_210,
      raw: {
        threadId: "thread_1",
        turnId: "turn_1",
        tokenUsage: {
          total: {
            totalTokens: 328_210,
            inputTokens: 327_000,
            cachedInputTokens: 294_300,
            outputTokens: 1_210
          },
          last: {
            totalTokens: 57_000
          },
          modelContextWindow: 100_000
        }
      }
    });

    await waitForExpect(() => {
      const card = vi.mocked(lark.patchCard).mock.calls.find(([messageId]) => messageId === "card_m1_1")?.[1];
      expect(card).toBeDefined();
      expect(JSON.stringify(card)).toContain("gpt-5.5 xhigh · 57% · ↑ 327 K (90%) ↓ 1.21 K");
    });

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForDelay();
  });

  it("updates the working card in place when queued messages are pending at completion", async () => {
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await turns[0]!.params.onAgentMessage?.({ id: "agent_1", text: "final answer" });
    manager.submitIncoming(message("m2", "/queue queued"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() =>
      expect(lark.patchCard).toHaveBeenCalledWith(
        "card_m1_1",
        expect.objectContaining({
          header: expect.objectContaining({
            template: "green",
            title: { tag: "plain_text", content: "已完成" }
          })
        })
      )
    );

    expect(lark.replyCard).not.toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({
        header: expect.objectContaining({ template: "green" })
      })
    );
    expect(lark.recallMessage).not.toHaveBeenCalledWith("card_m1_1");
  });

  it("updates the completed card in place when all turn senders have not read the working card", async () => {
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    vi.mocked(lark.getMessageReadOpenIds).mockResolvedValueOnce([]);
    const manager = createManager({ codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() =>
      expect(lark.patchCard).toHaveBeenCalledWith(
        "card_m1_1",
        expect.objectContaining({
          header: expect.objectContaining({
            template: "green",
            title: { tag: "plain_text", content: "已完成" }
          })
        })
      )
    );

    expect(lark.getMessageReadOpenIds).toHaveBeenCalledWith("card_m1_1");
    expect(lark.replyCard).toHaveBeenCalledTimes(1);
    expect(lark.recallMessage).not.toHaveBeenCalledWith("card_m1_1");
  });

  it("uses card mode to send a completed card, recall the working card, and skip the DONE reaction", async () => {
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({ id: "agent_1", text: "first item" });
        await onAgentMessage?.({ id: "agent_2", text: "second item" });
        return {
          threadId,
          turnId: "turn_1",
          text: "final aggregate should not be rendered",
          status: "completed" as const
        };
      })
    });
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, config: cardModeConfig({ iconImageKey: "img_logo" }) });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalled());
    await waitForExpect(() =>
      expect(lark.replyCard).toHaveBeenNthCalledWith(
        2,
        "m1",
        expect.objectContaining({
          header: expect.objectContaining({
            template: "green",
            title: { tag: "plain_text", content: "已完成" }
          })
        })
      )
    );

    const initialCard = vi.mocked(lark.replyCard).mock.calls[0]![1] as Record<string, unknown>;
    const finalCard = vi.mocked(lark.replyCard).mock.calls.at(-1)![1] as Record<string, unknown>;
    const finalBodyElements = (finalCard.body as { elements: unknown[] }).elements;
    const mentionElement = finalBodyElements[0] as Record<string, unknown>;
    const processPanel = finalBodyElements[1] as Record<string, unknown>;
    const finalContent = finalBodyElements.slice(2);
    expect(lark.replyCard).toHaveBeenCalledWith("m1", expect.any(Object));
    expect(JSON.stringify(initialCard)).toContain("img_logo");
    expect(JSON.stringify(initialCard)).toContain("暂无进度");
    expect(JSON.stringify(vi.mocked(lark.patchCard).mock.calls)).toContain("- first item");
    expect(JSON.stringify(mentionElement)).toContain("<at id=ou_guest></at>");
    expect(JSON.stringify(finalCard)).toContain("工作过程");
    expect(finalCard.config).toMatchObject({
      summary: { content: "second item" }
    });
    expect(JSON.stringify(processPanel)).toContain("first item");
    expect(JSON.stringify(processPanel)).not.toContain("second item");
    expect(JSON.stringify(finalContent)).toContain("second item");
    expect(JSON.stringify(finalCard)).not.toContain("final aggregate should not be rendered");
    expect(lark.replyMarkdown).not.toHaveBeenCalled();
    expect(lark.addCompletedReaction).not.toHaveBeenCalled();
    expect(lark.recallMessage).toHaveBeenCalledWith("card_m1_1");
  });

  it("uses agent message phase to keep commentary in card progress and final_answer as the result", async () => {
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({ id: "agent_1", text: "working notes", phase: "commentary" });
        await onAgentMessage?.({ id: "agent_2", text: "final answer", phase: "final_answer" });
        return {
          threadId,
          turnId: "turn_1",
          text: "working notes\n\nfinal answer",
          status: "completed" as const
        };
      })
    });
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() =>
      expect(lark.replyCard).toHaveBeenNthCalledWith(
        2,
        "m1",
        expect.objectContaining({
          header: expect.objectContaining({
            template: "green",
            title: { tag: "plain_text", content: "已完成" }
          })
        })
      )
    );

    const finalCard = vi.mocked(lark.replyCard).mock.calls.at(-1)![1] as Record<string, unknown>;
    const finalBodyElements = (finalCard.body as { elements: unknown[] }).elements;
    const processPanel = finalBodyElements[1] as Record<string, unknown>;
    const finalContent = finalBodyElements.slice(2);
    expect(finalCard.config).toMatchObject({
      summary: { content: "final answer" }
    });
    expect(JSON.stringify(processPanel)).toContain("working notes");
    expect(JSON.stringify(processPanel)).not.toContain("final answer");
    expect(JSON.stringify(finalContent)).toContain("final answer");
    expect(JSON.stringify(finalContent)).not.toContain("working notes");
    expect(lark.replyMarkdown).not.toHaveBeenCalled();
  });

  it("sets finished agent card summary to the first 100 final output characters", async () => {
    const finalText = "a".repeat(120);
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({ id: "agent_1", text: finalText });
        return {
          threadId,
          turnId: "turn_1",
          text: "final aggregate should not be rendered",
          status: "completed" as const
        };
      })
    });
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(2));

    const finalCard = vi.mocked(lark.replyCard).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(finalCard.config).toMatchObject({
      summary: { content: "a".repeat(100) }
    });
  });

  it("mentions each distinct Lark sender at the start of the completed card body", async () => {
    const { repository } = createRepository(groupConversationRecord());
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(groupMessage("m1", "first", { senderOpenId: "ou_first", senderName: "First User" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(groupMessage("m2", "second", { senderOpenId: "ou_second", senderName: "Second User" }));
    await waitForExpect(() => expect(codex.steerTurn).toHaveBeenCalledTimes(1));

    turns[0]!.resolve({
      threadId: "thread_1",
      turnId: "turn_1",
      text: "done",
      status: "completed"
    });
    await waitForExpect(() => expect(lark.recallMessage).toHaveBeenCalledWith("card_m2_2"));

    const finalCard = vi.mocked(lark.replyCard).mock.calls.at(-1)![1] as Record<string, unknown>;
    const firstBodyElement = (finalCard.body as { elements: unknown[] }).elements[0];
    expect(JSON.stringify(firstBodyElement)).toContain("<at id=ou_first></at> <at id=ou_second></at>");
  });

  it("records card button actions as control history and dispatches /next", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await turns[0]!.params.onAgentMessage?.({ id: "agent_1", text: "working" });
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));

    manager.submitCardAction({
      eventId: "event_card_next",
      operatorOpenId: "ou_guest",
      openMessageId: "card_m1_1",
      openChatId: "oc_ignored",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "next",
        stateKey: "p2p_ou_guest",
        runId: 1
      },
      raw: { event_id: "event_card_next" }
    });

    await waitForExpect(() =>
      expect(codex.interruptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "guest", threadId: "thread_1", turnId: "turn_1" })
      )
    );
    const cardActionInput = vi
      .mocked(repository.insertLarkMessage)
      .mock.calls.map(([input]) => input)
      .find((input) => input.routeKind === "card_action");
    expect(cardActionInput).toMatchObject({
      eventId: "event_card_next",
      larkUserId: "ou_guest",
      larkGroupId: "oc_ignored",
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_1",
      codexTurnId: "turn_1",
      routeKind: "card_action",
      status: "completed",
      text: "/next"
    });
    expect(cardActionInput).not.toHaveProperty("larkMessageId");
    expect(lark.replyText).not.toHaveBeenCalledWith(expect.any(String), expect.stringContaining("已打断当前任务"));

    turns[0]!.resolve(completed("thread_1", "turn_1", "interrupted"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("toggles queue mode via card action and updates the button label", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await turns[0]!.params.onAgentMessage?.({ id: "agent_1", text: "working" });
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    const initialCard = vi.mocked(lark.replyCard).mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(initialCard)).toContain("开启排队");
    expect(JSON.stringify(initialCard)).toContain("追加模式：新消息将被追加至当前任务。");

    manager.submitCardAction({
      eventId: "event_card_queue_1",
      operatorOpenId: "ou_guest",
      openMessageId: "card_m1_1",
      openChatId: "oc_ignored",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "queue",
        stateKey: "p2p_ou_guest",
        runId: 1
      },
      raw: { event_id: "event_card_queue_1" }
    });

    await waitForExpect(() => {
      const card = vi.mocked(lark.patchCard).mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
      expect(card).toBeDefined();
      expect(JSON.stringify(card)).toContain("关闭排队");
      expect(JSON.stringify(card)).toContain("排队模式：新消息将等待当前任务完成后发送。");
    });

    manager.submitCardAction({
      eventId: "event_card_queue_2",
      operatorOpenId: "ou_guest",
      openMessageId: "card_m1_1",
      openChatId: "oc_ignored",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "queue",
        stateKey: "p2p_ou_guest",
        runId: 1
      },
      raw: { event_id: "event_card_queue_2" }
    });

    await waitForExpect(() => {
      const card = vi.mocked(lark.patchCard).mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
      expect(card).toBeDefined();
      expect(JSON.stringify(card)).toContain("开启排队");
      expect(JSON.stringify(card)).toContain("追加模式：新消息将被追加至当前任务。");
    });

    manager.submitCardAction({
      eventId: "event_card_queue_3",
      operatorOpenId: "ou_guest",
      openMessageId: "card_m1_1",
      openChatId: "oc_ignored",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "queue",
        stateKey: "p2p_ou_guest",
        runId: 1
      },
      raw: { event_id: "event_card_queue_3" }
    });

    await waitForExpect(() => {
      const card = vi.mocked(lark.patchCard).mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
      expect(card).toBeDefined();
      expect(JSON.stringify(card)).toContain("关闭排队");
    });

    manager.submitIncoming(message("m2", "queued by card"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));
    await waitForExpect(() => {
      expect(
        vi
          .mocked(repository.insertLarkMessage)
          .mock.calls
          .map(([input]) => input)
          .some((input) => input.routeKind === "queued_message" && input.status === "queued" && input.text === "queued by card")
      ).toBe(true);
    });

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));

    const cardActions = vi
      .mocked(repository.insertLarkMessage)
      .mock.calls
      .map(([input]) => input)
      .filter((input) => input.routeKind === "card_action");
    expect(cardActions).toHaveLength(3);
    expect(cardActions[0]).toMatchObject({ eventId: "event_card_queue_1", text: "/queue" });
    expect(cardActions[1]).toMatchObject({ eventId: "event_card_queue_2", text: "/queue" });
    expect(cardActions[2]).toMatchObject({ eventId: "event_card_queue_3", text: "/queue" });
  });

  it("uploads SEND_TO_LARK image directives from completed agent messages and embeds them in the Lark post", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-send-image-"));
    const workspaceRoot = path.join(tempRoot, "workspaces");
    const workspace = path.join(workspaceRoot, "p2p_ou_guest");
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
    const workspace = path.join(workspaceRoot, "p2p_ou_guest");
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
    const workspace = path.join(workspaceRoot, "p2p_ou_guest");
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
      conversationKey: "p2p_ou_guest",
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
      outputDir: "/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m2"
    });
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input:
          '<lark_message lark_message_id="m2" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
          '<img path="/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m2/img_1.png" lark_file_key="img_1" size="789">Saved locally</img>\n' +
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
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));

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

  it("updates working agent cards as paused during shutdown without changing unfinished message state", async () => {
    const { codex } = createDeferredCodex();
    const lark = createLarkResponder();
    const { repository } = createRepository();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await manager.shutdown();

    await waitForExpect(() =>
      expect(lark.patchCard).toHaveBeenCalledWith(
        "card_m1_1",
        expect.objectContaining({
          header: expect.objectContaining({
            template: "grey",
            title: { tag: "plain_text", content: "工作中断" }
          })
        })
      )
    );
    const pausedCard = vi.mocked(lark.patchCard).mock.calls.at(-1)![1] as Record<string, unknown>;
    const serialized = JSON.stringify(pausedCard);
    expect(serialized).toContain("已暂停，服务重启后继续");
    expect(serialized).not.toContain("\"tag\":\"button\"");
    expect(serialized).not.toContain("停止");
    expect(serialized).not.toContain("打断并处理队列中消息");
    expect(repository.markLarkMessagesFailed).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesInterrupted).not.toHaveBeenCalled();
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
  config?: TwinnyConfig;
} = {}): ConversationManager {
  const workspaceRoot = options.workspaceRoot ?? "/tmp/twinny/workspaces";
  const managerConfig = options.config ?? config;
  return new ConversationManager({
    config: managerConfig,
    repository: options.repository ?? createRepository().repository,
    workspaces: {
      ensureWorkspace: (key) => path.join(workspaceRoot, key)
    },
    roles: {
      codexHomeFor: (role) => managerConfig.roles[role].codexHome
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

function cardModeConfig(overrides: Partial<TwinnyConfig["lark"]> = {}): TwinnyConfig {
  return {
    ...config,
    lark: {
      ...config.lark,
      agentMessageMode: "card",
      ...overrides
    }
  };
}

function createLarkUserDirectory(): LarkUserDirectory {
  return {
    getUserNameByOpenId: vi.fn(async () => "Guest User")
  };
}

function createLarkMessageReader(messages: Record<string, unknown | Error> | Error): LarkMessageReader {
  return {
    getMessage: vi.fn(async (messageId: string) => {
      if (messages instanceof Error) {
        throw messages;
      }
      const message = messages[messageId];
      if (!message) {
        throw new Error(`missing test message ${messageId}`);
      }
      if (message instanceof Error) {
        throw message;
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
    addQueuedReaction: vi.fn(async (messageId) => ({ messageId, reactionId: `queued_${messageId}` })),
    removeReaction: vi.fn(async () => undefined),
    replyText: vi.fn(async () => undefined),
    replyMarkdown: vi.fn(async (messageId) => ({ messageId: `reply_${messageId}_${++markdownReplyCount}` })),
    replyPost: vi.fn(async (messageId) => ({ messageId: `reply_${messageId}_${++markdownReplyCount}` })),
    replyFile: vi.fn(async (messageId) => ({ messageId: `reply_${messageId}_${++markdownReplyCount}` })),
    sendTextToOpenId: vi.fn(async () => undefined),
    sendCardToChatId: vi.fn(async (chatId) => ({ messageId: `card_${chatId}_${++markdownReplyCount}`, raw: {} })),
    forwardThreadToThread: vi.fn(async (threadId) => ({ messageId: `forward_${threadId}_${++markdownReplyCount}`, raw: {} })),
    replyCard: vi.fn(async (messageId) => ({ messageId: `card_${messageId}_${++markdownReplyCount}` })),
    patchCard: vi.fn(async (messageId) => ({ messageId })),
    recallMessage: vi.fn(async () => undefined),
    getMessageReadOpenIds: vi.fn(async () => ["ou_guest", "ou_owner", "ou_first", "ou_second"])
  };
}

function createRepository(initial?: ConversationRecord, options: {
  larkMessageIds?: string[];
  larkMessages?: LarkMessageRecord[];
  codexThreads?: CodexThreadRecord[];
  mainThreadHasRollout?: boolean;
} = {}): {
  repository: ConversationRepository;
  row: ConversationRecord | undefined;
} {
  let row = initial;
  const larkMessageIds = new Set(options.larkMessageIds ?? []);
  const larkMessages = new Map<string, LarkMessageRecord>();
  const larkMessagesByEventId = new Map<string, LarkMessageRecord>();
  const codexThreads = new Map<string, CodexThreadRecord>();
  let nextCodexThreadId = 1;
  for (const record of options.larkMessages ?? []) {
    if (record.larkMessageId) {
      larkMessageIds.add(record.larkMessageId);
      larkMessages.set(record.larkMessageId, record);
    }
    larkMessagesByEventId.set(record.eventId, record);
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
    codexThreadHasRollout?: boolean;
  }): CodexThreadRecord => {
    const existing = codexThreads.get(input.codexThreadId);
    const record = codexThreadRecord({
      ...existing,
      id: existing?.id ?? nextCodexThreadId++,
      codexThreadId: input.codexThreadId,
      conversationKey: input.conversationKey,
      larkThreadId: input.larkThreadId ?? existing?.larkThreadId,
      role: input.role,
      codexThreadHasRollout: existing?.codexThreadHasRollout === true || input.codexThreadHasRollout === true,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    });
    codexThreads.set(record.codexThreadId, record);
    return record;
  };
  const replaceCodexThreadForLarkThread = (
    conversationKey: string,
    larkThreadId: string,
    update: { codexThreadId: string; role: "owner" | "guest"; codexThreadHasRollout?: boolean }
  ): CodexThreadRecord => {
    const existing = getCodexThreadByLarkThread(conversationKey, larkThreadId);
    if (existing) {
      codexThreads.delete(existing.codexThreadId);
    }
    const record = codexThreadRecord({
      id: existing?.id ?? nextCodexThreadId++,
      codexThreadId: update.codexThreadId,
      conversationKey,
      larkThreadId,
      role: update.role,
      codexThreadHasRollout: update.codexThreadHasRollout ?? false,
      totalTokens: 0,
      tokenUsageJson: "{}",
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    });
    codexThreads.set(record.codexThreadId, record);
    return record;
  };
  if (row) {
    putCodexThread({
      codexThreadId: row.codexThreadId,
      conversationKey: row.conversationKey,
      role: row.role,
      codexThreadHasRollout: options.mainThreadHasRollout ?? true
    });
  }
  return {
    get row() {
      return row;
    },
    repository: {
      findByConversationKey: () => row ?? null,
      getCodexThreadById: vi.fn((codexThreadId) => codexThreads.get(codexThreadId)),
      getCodexThreadByConversationAndLarkThread: vi.fn(getCodexThreadByLarkThread),
      getLarkMessageById: vi.fn((larkMessageId) =>
        larkMessages.get(larkMessageId) ?? (larkMessageIds.has(larkMessageId) ? { larkMessageId } : undefined)
      ),
      getLarkMessageByEventId: vi.fn((eventId) => larkMessagesByEventId.get(eventId)),
      listUnfinishedLarkMessages: vi.fn(() => [...larkMessages.values()].filter((message) =>
        message.status === "processing" || message.status === "queued"
      )),
      create: (record) => {
        row = {
          id: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...record,
          responseMode: record.responseMode ?? (record.type === "p2p" ? "all" : "none")
        };
        putCodexThread({
          codexThreadId: row.codexThreadId,
          conversationKey: row.conversationKey,
          role: row.role,
          codexThreadHasRollout: false
        });
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
        const thread = codexThreads.get(codexThreadId);
        if (thread) {
          thread.codexThreadHasRollout = true;
          thread.updatedAt = Date.now();
        }
      },
      upsertCodexThread: vi.fn(putCodexThread),
      replaceCodexThreadForLarkThread: vi.fn(replaceCodexThreadForLarkThread),
      updateCodexThreadTokenUsage: vi.fn((input) => {
        const existing = codexThreads.get(input.codexThreadId);
        const record = codexThreadRecord({
          ...existing,
          codexThreadId: input.codexThreadId,
          conversationKey: input.conversationKey,
          role: input.role,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          cachedInputTokens: input.cachedInputTokens,
          reasoningOutputTokens: input.reasoningOutputTokens,
          totalTokens: input.totalTokens,
          contextTokens: input.contextTokens,
          contextWindow: input.contextWindow,
          codexThreadHasRollout: true,
          tokenUsageJson: input.tokenUsageJson,
          updatedAt: Date.now()
        });
        codexThreads.set(record.codexThreadId, record);
        return record;
      }),
      updateCodexThreadCard: vi.fn((input) => {
        const existing = codexThreads.get(input.codexThreadId);
        const record = codexThreadRecord({
          ...existing,
          codexThreadId: input.codexThreadId,
          conversationKey: input.conversationKey,
          larkThreadId: input.larkThreadId ?? existing?.larkThreadId,
          role: input.role,
          creatorOpenId: input.creatorOpenId ?? existing?.creatorOpenId,
          cardMessageId: input.cardMessageId ?? existing?.cardMessageId,
          codexThreadHasRollout: existing?.codexThreadHasRollout ?? false,
          updatedAt: Date.now()
        });
        codexThreads.set(record.codexThreadId, record);
        return record;
      }),
      getCodexThreadWorkStats: vi.fn((codexThreadId) => {
        const turns = new Map<string, { startedAt: number; terminalAt?: number }>();
        for (const message of larkMessages.values()) {
          if (message.codexThreadId !== codexThreadId || !message.codexTurnId || !message.processingStartedAt) {
            continue;
          }
          const existing = turns.get(message.codexTurnId);
          const terminalAt = message.completedAt ?? message.failedAt ?? message.clearedAt;
          turns.set(message.codexTurnId, {
            startedAt: Math.min(existing?.startedAt ?? message.processingStartedAt, message.processingStartedAt),
            terminalAt: Math.max(existing?.terminalAt ?? 0, terminalAt ?? 0) || existing?.terminalAt
          });
        }
        return {
          turnCount: turns.size,
          totalWorkDurationMs: [...turns.values()].reduce((sum, turn) =>
            sum + (turn.terminalAt && turn.terminalAt > turn.startedAt ? turn.terminalAt - turn.startedAt : 0), 0)
        };
      }),
      insertLarkMessage: vi.fn((input) => {
        const existing = larkMessagesByEventId.get(input.eventId);
        if (existing) {
          return existing;
        }
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
        if (input.larkMessageId) {
          larkMessageIds.add(input.larkMessageId);
          larkMessages.set(input.larkMessageId, record);
        }
        larkMessagesByEventId.set(input.eventId, record);
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
      markLarkMessagesProcessing: vi.fn((messageIds, update = {}) => {
        const now = Date.now();
        for (const messageId of messageIds) {
          const existing = larkMessages.get(messageId);
          if (!existing) {
            continue;
          }
          existing.status = "processing";
          existing.conversationKey = update.conversationKey ?? existing.conversationKey;
          existing.codexThreadId = update.codexThreadId ?? existing.codexThreadId;
          existing.codexTurnId = update.codexTurnId ?? existing.codexTurnId;
          existing.processingStartedAt = existing.processingStartedAt ?? now;
          existing.updatedAt = now;
        }
      }),
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
    conversationKey: "p2p_ou_guest",
    type: "p2p",
    chatId: "ou_guest",
    name: "Guest User",
    responseMode: "all",
    role: "guest",
    codexThreadId: "thread_1",
    workspace: "/tmp/twinny/workspaces/p2p_ou_guest",
    roleCodexHome: "/tmp/twinny/roles/guest/codex",
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  };
}

function groupConversationRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return conversationRecord({
    conversationKey: "group_oc_group",
    type: "group",
    chatId: "oc_group",
    name: "Team Room",
    responseMode: "all",
    codexThreadId: "thread_group",
    workspace: "/tmp/twinny/workspaces/group_oc_group",
    ...overrides
  });
}

function codexThreadRecord(overrides: Partial<CodexThreadRecord> = {}): CodexThreadRecord {
  return {
    id: 1,
    codexThreadId: "thread_1",
    conversationKey: "p2p_ou_guest",
    role: "guest",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
    contextWindow: 0,
    tokenUsageJson: "{}",
    codexThreadHasRollout: true,
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  };
}

function larkMessageRecord(overrides: Partial<LarkMessageRecord> = {}): LarkMessageRecord {
  const hasExplicitLarkMessageId = Object.prototype.hasOwnProperty.call(overrides, "larkMessageId");
  const larkMessageId = hasExplicitLarkMessageId ? overrides.larkMessageId : "m1";
  const rawMessageId = larkMessageId ?? "m1";
  const record: LarkMessageRecord = {
    id: 1,
    eventId: larkMessageId ? `e_${larkMessageId}` : "e_card_action",
    larkUserId: "ou_guest",
    conversationKey: "p2p_ou_guest",
    routeKind: "message",
    status: "processing",
    text: "hello",
    larkCreateTime: 1234,
    receivedAt: 100,
    updatedAt: 100,
    rawEventJson: JSON.stringify(rawReceiveEvent(rawMessageId, "hello")),
    ...overrides
  };
  if (larkMessageId) {
    record.larkMessageId = larkMessageId;
  }
  return record;
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

function botMenuAction(
  eventId: string,
  action: IncomingLarkBotMenuAction["action"],
  overrides: Partial<IncomingLarkBotMenuAction> = {}
): IncomingLarkBotMenuAction {
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
    },
    ...overrides
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

function wrappedMessage(text: string, messageId = "m1", senderOpenId = "ou_guest"): string {
  return `<lark_message lark_message_id="${messageId}" timestamp="1234" sender_ouid="${senderOpenId}" sender_name="Guest User">\n${text}\n</lark_message>`;
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
