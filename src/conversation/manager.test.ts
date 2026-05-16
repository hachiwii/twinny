import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TwinnyError } from "../errors.js";
import type {
  CodexTurnResult,
  ConversationRecord,
  IncomingLarkMessage,
  LarkMessageRecord,
  TwinnyConfig,
  UserRecord
} from "../types.js";
import {
  ConversationManager,
  type CodexBridge,
  type ConversationRepository,
  type LarkFileDownloader,
  type LarkResponder,
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
    expect(repository.upsertUser).toHaveBeenCalledWith({
      larkUserId: "ou_guest",
      name: "Guest User",
      role: "guest",
      seenAt: 1234
    });
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
    const { repository } = createRepository(undefined, {
      users: [{ larkUserId: "ou_guest", name: "Stored User", role: "guest" }]
    });
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
  larkFiles?: LarkFileDownloader;
  workspaceRoot?: string;
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
    larkFiles: options.larkFiles,
    nameLookupFailureTtlMs: 60_000
  });
}

function createLarkUserDirectory(): LarkUserDirectory {
  return {
    getUserNameByOpenId: vi.fn(async () => "Guest User")
  };
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
    replyFile: vi.fn(async (messageId) => ({ messageId: `reply_${messageId}_${++markdownReplyCount}` }))
  };
}

function createRepository(initial?: ConversationRecord, options: {
  users?: Array<{ larkUserId: string; name?: string; role?: "owner" | "guest" }>;
  larkMessageIds?: string[];
  larkMessages?: LarkMessageRecord[];
} = {}): {
  repository: ConversationRepository;
  row: ConversationRecord | undefined;
} {
  let row = initial;
  const users = new Map<string, UserRecord>();
  const larkMessageIds = new Set(options.larkMessageIds ?? []);
  const larkMessages = new Map<string, LarkMessageRecord>();
  for (const record of options.larkMessages ?? []) {
    larkMessageIds.add(record.larkMessageId);
    larkMessages.set(record.larkMessageId, record);
  }
  for (const user of options.users ?? []) {
    users.set(user.larkUserId, {
      id: users.size + 1,
      larkUserId: user.larkUserId,
      name: user.name ?? "",
      role: user.role ?? "guest",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastSeenAt: Date.now()
    });
  }
  return {
    get row() {
      return row;
    },
    repository: {
      findByConversationKey: () => row ?? null,
      getUserByLarkUserId: (larkUserId) => users.get(larkUserId),
      getCodexThreadById: vi.fn((codexThreadId) => ({
        id: 1,
        codexThreadId,
        conversationKey: row?.conversationKey ?? "p2p:ou_guest",
        role: row?.role ?? "guest",
        totalTokens: 0,
        tokenUsageJson: "{}",
        createdAt: Date.now(),
        updatedAt: Date.now()
      })),
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
      markThreadHasRollout: (_key, codexThreadId) => {
        if (row?.codexThreadId === codexThreadId) {
          row.codexThreadHasRollout = true;
          row.updatedAt = Date.now();
        }
      },
      upsertUser: vi.fn((input) => {
        const existing = users.get(input.larkUserId);
        const user: UserRecord = {
          id: existing?.id ?? users.size + 1,
          larkUserId: input.larkUserId,
          name: input.name?.trim() || existing?.name || "",
          role: input.role ?? existing?.role ?? "guest",
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          lastSeenAt: input.seenAt ?? Date.now()
        };
        users.set(input.larkUserId, user);
        return user;
      }),
      upsertCodexThread: vi.fn(),
      updateCodexThreadTokenUsage: vi.fn(),
      insertLarkMessage: vi.fn(),
      markLarkMessageQueued: vi.fn(),
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
