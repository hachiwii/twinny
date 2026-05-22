import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { describe, expect, it, vi, type Mock } from "vitest";
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
    messageRedaction: {
      email: "mask",
      chinesePhoneNumber: "mask"
    }
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
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });
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

      const summaryCard = vi
        .mocked(lark.patchCard)
        .mock.calls.filter(([messageId]) => messageId === "card_thread_1")
        .map(([, card]) => card)
        .find((card) => JSON.stringify(card).includes("**时长**\\n7s"));
      expect(summaryCard).toBeDefined();
      const serialized = JSON.stringify(summaryCard);
      expect(serialized).toContain("**输入**\\n0");
      expect(serialized).toContain("**输出**\\n0");
      expect(serialized).toContain("**时长**\\n7s");
      expect(serialized).toContain("thread_1");
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

  it("updates a bound thread card when Codex publishes a thread name update", async () => {
    const { repository } = createRepository(undefined, {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_named",
          conversationKey: "p2p_ou_guest",
          name: "旧标题",
          cardMessageId: "card_thread_named"
        })
      ]
    });
    const lark = createLarkResponder();
    const manager = createManager({ repository, lark });

    manager.submitCodexThreadNameUpdated({ threadId: "thread_named", name: "  新标题\n来自 Codex  " });

    await waitForExpect(() =>
      expect(repository.updateCodexThreadName).toHaveBeenCalledWith("thread_named", "新标题 来自 Codex")
    );
    await waitForExpect(() => expect(lark.patchCard).toHaveBeenCalledWith("card_thread_named", expect.any(Object)));
    const card = vi.mocked(lark.patchCard).mock.calls.find(([messageId]) => messageId === "card_thread_named")?.[1];
    expect(JSON.stringify(card)).toContain("新标题 来自 Codex");
  });

  it("passes the current thread name when starting a Codex turn", async () => {
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_1",
          conversationKey: "p2p_ou_guest",
          name: "当前标题"
        })
      ]
    });
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "hello"));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: wrappedMessage("hello", "m1"),
        currentThreadName: "当前标题"
      })
    );
  });

  it("handles set_thread_name tool calls by updating cards and syncing Codex thread name", async () => {
    const turn = deferred<CodexTurnResult>();
    let turnParams: Parameters<CodexBridge["startTurn"]>[0] | undefined;
    const codex = createCodex({
      setThreadName: vi.fn(async () => undefined),
      startTurn: vi.fn((params) => {
        turnParams = params;
        void params.onTurnStarted?.("turn_1");
        return turn.promise;
      })
    });
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_1",
          conversationKey: "p2p_ou_guest",
          name: "旧标题",
          cardMessageId: "card_thread_1"
        })
      ]
    });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    try {
      manager.submitIncoming(message("m1", "hello"));
      await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
      await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

      const response = await turnParams?.onSetThreadName?.({
        requestId: "req_1",
        threadId: "thread_1",
        turnId: "turn_1",
        callId: "call_1",
        name: "  新标题\n来自工具  ",
        rawArguments: { name: "  新标题\n来自工具  " }
      });

      expect(response).toEqual({
        success: true,
        contentItems: [{ type: "inputText", text: "Thread name updated to: 新标题 来自工具" }]
      });
      expect(repository.updateCodexThreadName).toHaveBeenCalledWith("thread_1", "新标题 来自工具");
      await waitForExpect(() =>
        expect(codex.setThreadName).toHaveBeenCalledWith({
          role: "guest",
          threadId: "thread_1",
          name: "新标题 来自工具"
        })
      );
      await waitForExpect(() =>
        expect(vi.mocked(lark.patchCard).mock.calls.some(([, card]) =>
          JSON.stringify(card).includes("[已更新标题] 新标题 来自工具")
        )).toBe(true)
      );
    } finally {
      turn.resolve(completed("thread_1", "turn_1"));
      await turn.promise;
      await waitForDelay();
    }
  });

  it("applies a Codex thread name update that arrives before the thread card is stored", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row);
    const codex = createCodex({ startThread: vi.fn(async () => ({ threadId: "thread_pending_name" })) });
    const lark = createLarkResponder();
    vi.mocked(lark.replyText).mockResolvedValueOnce({
      messageId: "reply_pending_name_1",
      raw: { data: { thread_id: "topic_pending_name" } }
    });
    const manager = createManager({ repository, codex, lark });

    manager.submitCodexThreadNameUpdated({ threadId: "thread_pending_name", name: "  Codex 生成标题  " });
    await waitForExpect(() =>
      expect(repository.updateCodexThreadName).toHaveBeenCalledWith("thread_pending_name", "Codex 生成标题")
    );

    manager.submitIncoming(groupMessage("g_thread_pending_name", "/thread", { senderOpenId: "ou_guest" }));

    await waitForExpect(() => expect(lark.sendCardToChatId).toHaveBeenCalledTimes(1));
    expect(lark.sendCardToChatId).toHaveBeenCalledWith(
      "oc_group",
      expect.objectContaining({
        header: expect.objectContaining({
          title: { tag: "plain_text", content: "Codex 生成标题" }
        })
      }),
      { uuid: expect.stringMatching(UUID_PATTERN) }
    );
    expect(repository.updateCodexThreadCard).toHaveBeenCalledWith({
      conversationKey: "group_oc_group",
      codexThreadId: "thread_pending_name",
      role: "owner",
      name: "Codex 生成标题",
      creatorOpenId: "ou_guest"
    });
    await expect(Promise.resolve(repository.getCodexThreadById("thread_pending_name"))).resolves.toMatchObject({
      name: "Codex 生成标题"
    });
    expect(repository.updateCodexThreadCard).toHaveBeenLastCalledWith({
      conversationKey: "group_oc_group",
      codexThreadId: "thread_pending_name",
      role: "owner",
      larkThreadId: "topic_pending_name",
      creatorOpenId: "ou_guest",
      cardMessageId: "card_oc_group_1"
    });
  });

  it("patches a thread card when Codex renames it before the card message id is stored", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row);
    const codex = createCodex({ startThread: vi.fn(async () => ({ threadId: "thread_inflight_name" })) });
    const lark = createLarkResponder();
    const sentCard = deferred<{ messageId: string; raw: Record<string, unknown> }>();
    vi.mocked(lark.sendCardToChatId).mockImplementationOnce(async () => sentCard.promise);
    vi.mocked(lark.replyText).mockResolvedValueOnce({
      messageId: "reply_inflight_name_1",
      raw: { data: { thread_id: "topic_inflight_name" } }
    });
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_thread_inflight_name", "/thread", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(lark.sendCardToChatId).toHaveBeenCalledTimes(1));

    manager.submitCodexThreadNameUpdated({ threadId: "thread_inflight_name", name: "Codex 补发标题" });
    await waitForExpect(() =>
      expect(repository.updateCodexThreadName).toHaveBeenCalledWith("thread_inflight_name", "Codex 补发标题")
    );

    sentCard.resolve({ messageId: "card_inflight_name", raw: { data: { thread_id: "topic_inflight_name" } } });

    await waitForExpect(() =>
      expect(lark.patchCard).toHaveBeenCalledWith("card_inflight_name", expect.any(Object))
    );
    const patchedCard = vi
      .mocked(lark.patchCard)
      .mock.calls.find(([messageId]) => messageId === "card_inflight_name")?.[1];
    expect(JSON.stringify(patchedCard)).toContain("Codex 补发标题");
    await expect(Promise.resolve(repository.getCodexThreadById("thread_inflight_name"))).resolves.toMatchObject({
      name: "Codex 补发标题"
    });
  });

  it("patches a bound thread card when thread status colors change", async () => {
    const row = conversationRecord({ codexThreadId: "thread_status_color" });
    const { repository } = createRepository(row, {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_status_color",
          conversationKey: "p2p_ou_guest",
          cardMessageId: "card_thread_status_color"
        })
      ]
    });
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    vi.mocked(lark.getMessageReadOpenIds).mockResolvedValue([]);
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });
    const responder = {
      respond: vi.fn(),
      reject: vi.fn()
    };
    const expectThreadTemplate = async (template: string) => {
      await waitForExpect(() => {
        const card = vi
          .mocked(lark.patchCard)
          .mock.calls.filter(([messageId]) => messageId === "card_thread_status_color")
          .at(-1)?.[1] as Record<string, unknown> | undefined;
        expect(card?.header).toMatchObject({ template });
      });
    };

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await expectThreadTemplate("purple");

    await turns[0]!.params.onRequestUserInput?.(
      {
        requestId: "request_1",
        params: {
          threadId: "thread_status_color",
          turnId: "turn_1",
          itemId: "item_1",
          questions: [
            {
              id: "choice",
              header: "Choose mode",
              question: "Choose mode",
              isOther: false,
              isSecret: false,
              options: null
            }
          ]
        }
      },
      responder
    );
    await expectThreadTemplate("yellow");

    manager.submitCardAction({
      eventId: "event_request_submit",
      operatorOpenId: "ou_guest",
      openMessageId: "card_m1_1",
      openChatId: "oc_ignored",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "request_input_submit",
        stateKey: "p2p_ou_guest",
        runId: 1
      },
      formValue: {},
      raw: { event_id: "event_request_submit" }
    });
    await waitForExpect(() => expect(responder.respond).toHaveBeenCalled());
    await expectThreadTemplate("purple");

    turns[0]!.resolve(completed("thread_status_color", "turn_1"));
    await waitForExpect(() =>
      expect(repository.updateCodexThreadStatus).toHaveBeenCalledWith("p2p_ou_guest", "thread_status_color", "idle")
    );
    await expectThreadTemplate("blue");
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

  it("queues owner ordinary messages on another user's active turn while still allowing owner stop", async () => {
    const { repository } = createRepository(groupConversationRecord());
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository, codex });

    manager.submitIncoming(groupMessage("g1", "active", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    manager.submitIncoming(groupMessage("g2", "owner follow-up", { senderOpenId: "ou_owner" }));
    await waitForExpect(() => expect(manager.queueDepth("group_oc_group")).toBe(1));

    expect(codex.steerTurn).not.toHaveBeenCalled();
    await waitForExpect(() =>
      expect(repository.insertLarkMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          larkMessageId: "g2",
          larkUserId: "ou_owner",
          routeKind: "queued_message",
          status: "queued",
          text: "owner follow-up"
        })
      )
    );

    manager.submitIncoming(groupMessage("g3", "/stop", { senderOpenId: "ou_owner" }));
    await waitForExpect(() =>
      expect(codex.interruptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "guest", threadId: "thread_group", turnId: "turn_1" })
      )
    );
    expect(repository.markLarkMessagesCleared).toHaveBeenCalledWith(["g2"]);

    turns[0]!.resolve(completed("thread_group", "turn_1", "interrupted"));
  });

  it("auto-steers owner ordinary messages when owner owns the active turn", async () => {
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository: createRepository(groupConversationRecord()).repository, codex });

    manager.submitIncoming(groupMessage("g1", "owner active", { senderOpenId: "ou_owner" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(groupMessage("g2", "owner follow-up", { senderOpenId: "ou_owner" }));

    await waitForExpect(() =>
      expect(codex.steerTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread_group",
          turnId: "turn_1",
          input: wrappedMessage("owner follow-up", "g2", "ou_owner")
        })
      )
    );
    expect(manager.queueDepth("group_oc_group")).toBe(0);

    turns[0]!.resolve(completed("thread_group", "turn_1"));
  });

  it("starts a different user's queued message before a later trigger-user message", async () => {
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository: createRepository(groupConversationRecord()).repository, codex });

    manager.submitIncoming(groupMessage("g1", "active", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(groupMessage("g2", "other queued", { senderOpenId: "ou_other" }));
    manager.submitIncoming(groupMessage("g3", "same later", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(manager.queueDepth("group_oc_group")).toBe(2));

    expect(codex.steerTurn).not.toHaveBeenCalled();

    turns[0]!.resolve(completed("thread_group", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: wrappedMessage("other queued", "g2", "ou_other") })
    );
    expect(manager.queueDepth("group_oc_group")).toBe(1);

    turns[1]!.resolve(completed("thread_group", "turn_2"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(3));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ input: wrappedMessage("same later", "g3", "ou_guest") })
    );

    turns[2]!.resolve(completed("thread_group", "turn_3"));
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

  it("enables plan mode without starting a turn when /plan has no body", async () => {
    const { repository } = createRepository();
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "/plan"));

    await waitForExpect(() =>
      expect(repository.updateCodexThreadMode).toHaveBeenCalledWith("p2p_ou_guest", "thread_1", "plan")
    );
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m1"]);
    expect(lark.replyText).toHaveBeenCalledWith("m1", "已开启 plan mode。");
  });

  it("starts /plan body as a plan-mode turn", async () => {
    const { repository } = createRepository(conversationRecord());
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "/plan investigate plan mode"));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(repository.updateCodexThreadMode).toHaveBeenCalledWith("p2p_ou_guest", "thread_1", "plan");
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
        input: wrappedMessage("investigate plan mode", "m1")
      })
    );
  });

  it("runs /goal as a queued goal message and exits stored plan mode", async () => {
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [codexThreadRecord({ codexThreadId: "thread_1", mode: "plan" })]
    });
    const { codex, goals } = createDeferredGoalCodex();
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "/goal   implement the queued target"));

    await waitForExpect(() => expect(codex.runGoal).toHaveBeenCalledTimes(1));
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "m1",
        routeKind: "goal_message",
        status: "queued",
        text: "implement the queued target"
      })
    );
    expect(repository.updateCodexThreadMode).toHaveBeenCalledWith("p2p_ou_guest", "thread_1", "default");
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(codex.runGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "guest",
        threadId: "thread_1",
        objective: "implement the queued target"
      })
    );

    goals[0]!.resolve({ ...completed("thread_1", "goal_1"), text: "goal done" });
    await waitForExpect(() => expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m1"]));
  });

  it("allows /queue /goal and rejects /plan /goal or /side /goal", async () => {
    const { repository } = createRepository();
    const { codex, goals } = createDeferredGoalCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "/queue /goal queued target"));
    await waitForExpect(() => expect(codex.runGoal).toHaveBeenCalledTimes(1));
    expect(codex.runGoal).toHaveBeenCalledWith(expect.objectContaining({ objective: "queued target" }));
    goals[0]!.resolve(completed("thread_1", "goal_1"));
    await waitForExpect(() => expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m1"]));

    manager.submitIncoming(message("m2", "/plan /goal invalid"));
    manager.submitIncoming(message("m3", "/side /goal invalid"));

    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledWith("m2", "goal 不能在 plan 中使用。"));
    expect(lark.replyText).toHaveBeenCalledWith("m3", "goal 不能在 side 中使用。");
    expect(codex.runGoal).toHaveBeenCalledTimes(1);
  });

  it("runs /compact as a queued control command without starting a normal turn", async () => {
    const { repository } = createRepository(conversationRecord());
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "/compact"));

    await waitForExpect(() => expect(codex.compactThread).toHaveBeenCalledTimes(1));
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(codex.compactThread).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "guest",
        threadId: "thread_1",
        cwd: "/tmp/twinny/workspaces/p2p_ou_guest",
        approvalPolicy: "never"
      })
    );
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "m1",
        routeKind: "queued_message",
        status: "queued",
        text: "/compact"
      })
    );
    await waitForExpect(() => expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m1"]));
  });

  it("queues /compact behind an active turn and runs it after the turn completes", async () => {
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ codex });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/compact"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));

    expect(codex.compactThread).not.toHaveBeenCalled();
    turns[0]!.resolve(completed("thread_1", "turn_1"));

    await waitForExpect(() => expect(codex.compactThread).toHaveBeenCalledTimes(1));
    expect(codex.steerTurn).not.toHaveBeenCalled();
  });

  it("consumes a same-user /compact queued while plan waiting", async () => {
    const turns: Array<Deferred<CodexTurnResult> & { params: Parameters<CodexBridge["startTurn"]>[0] }> = [];
    const compacts: Array<Deferred<CodexTurnResult> & { params: Parameters<CodexBridge["compactThread"]>[0] }> = [];
    const codex = createCodex({
      startTurn: vi.fn((params) => {
        const turn = deferred<CodexTurnResult>();
        turns.push({ ...turn, params });
        void params.onTurnStarted?.(`turn_${turns.length}`);
        return turn.promise;
      }),
      compactThread: vi.fn((params) => {
        const compact = deferred<CodexTurnResult>();
        compacts.push({ ...compact, params });
        void params.onTurnStarted?.(`compact_${compacts.length}`);
        return compact.promise;
      })
    });
    const manager = createManager({ codex });

    manager.submitIncoming(message("m1", "draft a plan"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await turns[0]!.params.onPlanUpdated?.({
      threadId: "thread_1",
      turnId: "turn_1",
      explanation: "Plan ready",
      plan: [{ step: "Update the implementation", status: "pending" }]
    });

    manager.submitIncoming(message("m2", "/compact"));

    await waitForExpect(() =>
      expect(codex.interruptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "guest", threadId: "thread_1", turnId: "turn_1" })
      )
    );
    turns[0]!.resolve(completed("thread_1", "turn_1", "interrupted"));
    await waitForExpect(() => expect(codex.compactThread).toHaveBeenCalledTimes(1));
    expect(compacts[0]!.params.threadId).toBe("thread_1");

    compacts[0]!.resolve(completed("thread_1", "compact_1"));
  });

  it("keeps a different-user /compact queued while plan waiting", async () => {
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository: createRepository(groupConversationRecord()).repository, codex });

    manager.submitIncoming(groupMessage("g1", "draft a plan", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await turns[0]!.params.onPlanUpdated?.({
      threadId: "thread_group",
      turnId: "turn_1",
      explanation: "Plan ready",
      plan: [{ step: "Update the implementation", status: "pending" }]
    });

    manager.submitIncoming(groupMessage("g2", "/compact", { senderOpenId: "ou_other" }));

    await waitForExpect(() => expect(manager.queueDepth("group_oc_group")).toBe(1));
    await waitForDelay();
    expect(codex.interruptTurn).not.toHaveBeenCalled();
    expect(codex.compactThread).not.toHaveBeenCalled();

    turns[0]!.resolve(completed("thread_group", "turn_1"));
  });

  it("queues ordinary messages while compact is active instead of steering them", async () => {
    const { codex, compacts } = createDeferredCompactCodex();
    const manager = createManager({ codex });

    manager.submitIncoming(message("m1", "/compact"));
    await waitForExpect(() => expect(codex.compactThread).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "during compact"));

    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));
    expect(codex.steerTurn).not.toHaveBeenCalled();

    compacts[0]!.resolve(completed("thread_1", "compact_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ input: wrappedMessage("during compact", "m2") })
    );
  });

  it("does not steer queued messages into an active compact", async () => {
    const { codex } = createDeferredCompactCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark });

    manager.submitIncoming(message("m1", "/compact"));
    await waitForExpect(() => expect(codex.compactThread).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));
    manager.submitIncoming(message("m3", "/steer"));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("m3", "当前 compact 不支持注入，队列保持不变。")
    );
    expect(codex.steerTurn).not.toHaveBeenCalled();
    expect(manager.queueDepth("p2p_ou_guest")).toBe(1);
  });

  it("interrupts active compact on /stop", async () => {
    const { codex } = createDeferredCompactCodex();
    const manager = createManager({ codex });

    manager.submitIncoming(message("m1", "/compact"));
    await waitForExpect(() => expect(codex.compactThread).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/stop"));

    await waitForExpect(() =>
      expect(codex.interruptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread_1", turnId: "compact_1" })
      )
    );
  });

  it("interrupts active compact on /next and then starts the queued batch", async () => {
    const { codex, compacts } = createDeferredCompactCodex();
    const manager = createManager({ codex });

    manager.submitIncoming(message("m1", "/compact"));
    await waitForExpect(() => expect(codex.compactThread).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued after compact"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));
    manager.submitIncoming(message("m3", "/next"));
    await waitForExpect(() => expect(codex.interruptTurn).toHaveBeenCalledTimes(1));

    compacts[0]!.resolve(completed("thread_1", "compact_1", "interrupted"));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ input: wrappedMessage("queued after compact", "m2") })
    );
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

  it("only checks non-text queued messages for recall before processing", async () => {
    const { repository } = createRepository(groupConversationRecord());
    const { codex, turns } = createDeferredCodex();
    const larkMessages = createLarkMessageReader({
      m2: fetchedLarkMessage("m2", "image", JSON.stringify({ image_key: "img_updated" }))
    });
    const manager = createManager({ repository, codex, larkMessages });

    manager.submitIncoming(groupMessage("m1", "active", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(groupMessage("m2", "stored image", {
      messageType: "image",
      senderOpenId: "ou_other",
      raw: rawReceiveEvent("m2", "stored image", {
        message_type: "image",
        content: JSON.stringify({ image_key: "img_old" }),
        chat_id: "oc_group",
        chat_type: "group"
      })
    }));
    await waitForExpect(() => expect(manager.queueDepth("group_oc_group")).toBe(1));

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(larkMessages.getMessage).toHaveBeenCalledWith("m2");
    expect(repository.updateQueuedLarkMessage).not.toHaveBeenCalled();
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: wrappedMessage("stored image", "m2", "ou_other") })
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
    expect(lark.replyText).toHaveBeenCalledWith("m1", expect.stringContaining("/goal <objective> -"));
    expect(codex.startTurn).not.toHaveBeenCalled();
  });

  it("replies to /logo with the uploaded logo image key", async () => {
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, assetImageKeys: { logoImageKey: "img_logo" } });

    manager.submitIncoming(message("m1", "/logo"));

    await waitForExpect(() => expect(lark.replyImage).toHaveBeenCalledWith("m1", "img_logo"));
    expect(codex.startTurn).not.toHaveBeenCalled();
  });

  it("reports an error for /logo when no logo image key is available", async () => {
    const lark = createLarkResponder();
    const manager = createManager({ lark, assetImageKeys: {} });

    manager.submitIncoming(message("m1", "/logo"));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("m1", "logo.png 暂无可用 image_key，无法发送。")
    );
    expect(lark.replyImage).not.toHaveBeenCalled();
  });

  it("replies to /twinny and /banner with the banner card", async () => {
    const lark = createLarkResponder();
    const manager = createManager({ lark, assetImageKeys: { bannerImageKey: "img_banner" } });

    manager.submitIncoming(message("m1", "/twinny"));
    manager.submitIncoming(message("m2", "/banner"));

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(vi.mocked(lark.replyCard).mock.calls[0]![1])).toContain("img_banner");
    expect(JSON.stringify(vi.mocked(lark.replyCard).mock.calls[1]![1])).toContain("Twinny v0.4.0");
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

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    expect(lark.replyCard).toHaveBeenCalledWith("m1", expect.objectContaining({ schema: "2.0" }));
    const card = vi.mocked(lark.replyCard).mock.calls[0]![1] as Record<string, unknown>;
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("话题");
    expect(serialized).toContain("thread_status");
    expect(serialized).toContain("GPT-5.5 (xhigh)");
    expect(serialized).toContain("80 (50% Cached)");
    expect(serialized).toContain("20 (25% Reasoning)");
    expect(serialized).toContain("工作区");
    expect(serialized).toContain("p2p_ou_guest");
    expect(serialized).toContain("用户");
    expect(serialized).toContain("ou_guest");
    expect(serialized).not.toContain("系统");
    expect(lark.sendEphemeralCardToChatId).not.toHaveBeenCalled();
    expect(lark.replyText).not.toHaveBeenCalled();
    expect(codex.readAccountRateLimits).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m1"]);
  });

  it("sends /status as an ephemeral card in ordinary groups", async () => {
    const row = groupConversationRecord({ responseMode: "all", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g_status", "/status"));

    await waitForExpect(() => expect(lark.sendEphemeralCardToChatId).toHaveBeenCalledTimes(1));
    expect(lark.sendEphemeralCardToChatId).toHaveBeenCalledWith(
      "oc_group",
      "ou_guest",
      expect.objectContaining({ schema: "2.0" })
    );
    expect(JSON.stringify(vi.mocked(lark.sendEphemeralCardToChatId).mock.calls[0]![2])).toContain("group_oc_group");
    expect(lark.replyCard).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g_status"]);
  });

  it("replies to /status with a default card in topic groups", async () => {
    const row = groupConversationRecord({ responseMode: "all", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("topic_status", "/status", {
      chatType: "topic_group",
      larkThreadId: "topic_thread"
    }));

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    expect(lark.replyCard).toHaveBeenCalledWith("topic_status", expect.objectContaining({ schema: "2.0" }));
    expect(lark.sendEphemeralCardToChatId).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["topic_status"]);
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

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    expect(codex.readAccountRateLimits).toHaveBeenCalledWith({ role: "owner" });
    const card = vi.mocked(lark.replyCard).mock.calls[0]![1] as Record<string, unknown>;
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("p2p_ou_owner");
    expect(serialized).toContain("系统");
    expect(serialized).toContain("Twinny 版本");
    expect(serialized).toContain("CodeX 版本");
    expect(serialized).toContain("Lark App ID");
    expect(serialized).toContain("cli_xxx");
    expect(serialized).toContain("12.5%");
    expect(serialized).toContain("34%");
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

  it("clears the active goal before stopping it", async () => {
    const { codex, goals } = createDeferredGoalCodex();
    const manager = createManager({ codex });

    manager.submitIncoming(message("m1", "/goal finish the target"));
    await waitForExpect(() => expect(codex.runGoal).toHaveBeenCalledTimes(1));

    manager.submitIncoming(message("m2", "/stop"));

    await waitForExpect(() => expect(codex.clearThreadGoal).toHaveBeenCalledWith({ role: "guest", threadId: "thread_1" }));
    expect(codex.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "guest", threadId: "thread_1", turnId: "goal_1" })
    );
    const clearOrder = vi.mocked(codex.clearThreadGoal!).mock.invocationCallOrder[0];
    const interruptOrder = vi.mocked(codex.interruptTurn).mock.invocationCallOrder[0];
    expect(clearOrder).toBeDefined();
    expect(interruptOrder).toBeDefined();
    expect(clearOrder!).toBeLessThan(interruptOrder!);

    goals[0]!.resolve(completed("thread_1", "goal_1", "interrupted"));
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

  it("starts the next queued message when Codex reports the interrupted turn is already inactive", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    vi.mocked(codex.interruptTurn).mockRejectedValueOnce(
      new TwinnyError("no active turn to interrupt", "CODEX_REQUEST_FAILED", {
        code: -32600,
        message: "no active turn to interrupt"
      })
    );
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue queued one"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));

    manager.submitIncoming(message("m3", "/next"));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: wrappedMessage("queued one", "m2") })
    );
    expect(manager.queueDepth("p2p_ou_guest")).toBe(0);
    expect(repository.markLarkMessagesInterrupted).toHaveBeenCalledWith(["m1"]);
    expect(lark.replyText).toHaveBeenCalledWith(
      "m3",
      "已打断当前任务，将执行队列中的下一条消息。队列剩余 0 条。"
    );

    turns[1]!.resolve(completed("thread_1", "turn_2"));
    turns[0]!.resolve(completed("thread_1", "turn_1", "interrupted"));
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

  it("steers queued ordinary messages into an active goal on /steer", async () => {
    const { repository } = createRepository();
    const { codex, goals } = createDeferredGoalCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "/goal finish the target"));
    await waitForExpect(() => expect(codex.runGoal).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/queue extra context"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));

    manager.submitIncoming(message("m3", "/steer"));

    await waitForExpect(() => expect(codex.steerTurn).toHaveBeenCalledTimes(1));
    expect(codex.steerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "guest",
        threadId: "thread_1",
        turnId: "goal_1",
        input: wrappedMessage("extra context", "m2")
      })
    );
    expect(repository.markLarkMessagesSteered).toHaveBeenCalledWith(["m1"], {
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_1",
      codexTurnId: "goal_1"
    });
    expect(lark.replyText).toHaveBeenCalledWith("m3", "已将队列中的 1 条消息注入当前任务。队列剩余 0 条。");

    goals[0]!.resolve(completed("thread_1", "goal_1"));
  });

  it("treats /steer on a queued control message during a goal like /next", async () => {
    const { codex, goals } = createDeferredGoalCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark });

    manager.submitIncoming(message("m1", "/goal finish the target"));
    await waitForExpect(() => expect(codex.runGoal).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "/plan queued plan"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));

    manager.submitIncoming(message("m3", "/steer"));

    await waitForExpect(() => expect(codex.clearThreadGoal).toHaveBeenCalledWith({ role: "guest", threadId: "thread_1" }));
    expect(codex.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "guest", threadId: "thread_1", turnId: "goal_1" })
    );
    const clearOrder = vi.mocked(codex.clearThreadGoal!).mock.invocationCallOrder[0];
    const interruptOrder = vi.mocked(codex.interruptTurn).mock.invocationCallOrder[0];
    expect(clearOrder).toBeDefined();
    expect(interruptOrder).toBeDefined();
    expect(clearOrder!).toBeLessThan(interruptOrder!);
    expect(lark.replyText).toHaveBeenCalledWith("m3", "队首是控制消息，已打断当前目标并开始执行队列。");

    goals[0]!.resolve(completed("thread_1", "goal_1", "interrupted"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
        input: wrappedMessage("queued plan", "m2")
      })
    );
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
    vi.mocked(lark.replyText).mockResolvedValueOnce({
      messageId: "reply_empty_1",
      raw: { data: { thread_id: "topic_thread_empty" } }
    });
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
      larkThreadId: "topic_thread_empty",
      creatorOpenId: "ou_guest",
      cardMessageId: "card_oc_group_1"
    });
    expect(lark.replyText).toHaveBeenCalledWith(
      "card_oc_group_1",
      '话题由 <at user_id="ou_guest">Guest User</at> 创建',
      { replyInThread: true }
    );
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
      raw: {}
    });
    vi.mocked(lark.replyText)
      .mockResolvedValueOnce({
        messageId: "reply_thread_intro_1",
        raw: { data: { thread_id: cardThreadId } }
      })
      .mockResolvedValueOnce({
        messageId: "reply_thread_1",
        raw: { data: { thread_id: cardThreadId } }
      });
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
    expect(lark.replyText).toHaveBeenNthCalledWith(
      1,
      cardMessageId,
      '话题由 <at user_id="ou_guest">Guest User</at> 创建',
      { replyInThread: true }
    );
    expect(lark.replyText).toHaveBeenNthCalledWith(2, cardMessageId, "topic first", { replyInThread: true });
    expect(lark.recallMessage).toHaveBeenCalledWith("g_thread");
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
    const storedThreadReply = vi
      .mocked(repository.insertLarkMessage)
      .mock.calls.find(([input]) => input.larkMessageId === "reply_thread_1")?.[0];
    expect(JSON.parse(storedThreadReply?.rawEventJson ?? "{}")).toMatchObject({
      event_id: "thread_reply:e_g_thread",
      sender: { sender_id: { open_id: "ou_guest" } },
      message: {
        message_id: "reply_thread_1",
        chat_id: "oc_group",
        chat_type: "topic_group",
        message_type: "text",
        thread_id: cardThreadId
      }
    });
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g_thread"]);
    await waitForExpect(() =>
      expect(lark.patchCard).toHaveBeenCalledWith(
        cardMessageId,
        expect.objectContaining({
          header: expect.objectContaining({
            title: { tag: "plain_text", content: "topic first" }
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

  it("parses slash commands from /thread initial text before starting the topic turn", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_thread_plan" }))
    });
    const lark = createLarkResponder();
    const cardMessageId = "card_oc_group_1";
    const cardThreadId = "topic_thread_plan";
    vi.mocked(lark.sendCardToChatId).mockResolvedValueOnce({
      messageId: cardMessageId,
      raw: {}
    });
    vi.mocked(lark.replyText)
      .mockResolvedValueOnce({
        messageId: "reply_thread_plan_intro_1",
        raw: { data: { thread_id: cardThreadId } }
      })
      .mockResolvedValueOnce({
        messageId: "reply_thread_plan_1",
        raw: { data: { thread_id: cardThreadId } }
      });
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_thread_plan", "/thread /plan investigate plan mode", {
      senderOpenId: "ou_guest"
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(lark.replyText).toHaveBeenNthCalledWith(
      1,
      cardMessageId,
      '话题由 <at user_id="ou_guest">Guest User</at> 创建',
      { replyInThread: true }
    );
    expect(lark.replyText).toHaveBeenNthCalledWith(2, cardMessageId, "/plan investigate plan mode", { replyInThread: true });
    expect(lark.recallMessage).toHaveBeenCalledWith("g_thread_plan");
    expect(repository.updateCodexThreadMode).toHaveBeenCalledWith("group_oc_group", "thread_thread_plan", "plan");
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_thread_plan",
        mode: "plan",
        input: wrappedMessage("investigate plan mode", "reply_thread_plan_1", "ou_guest")
      })
    );
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "reply_thread_plan_1",
        eventId: "thread_reply:e_g_thread_plan",
        larkThreadId: cardThreadId,
        routeKind: "queued_message",
        status: "queued",
        text: "investigate plan mode"
      })
    );
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g_thread_plan"]);
  });

  it("forks the current group Codex thread into a new topic and proxies initial text", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      forkThread: vi.fn(async () => ({ threadId: "thread_forked" })),
      startTurn: vi.fn(async ({ threadId, onTurnStarted }) => {
        await onTurnStarted?.("turn_1");
        return completed(threadId, "turn_1");
      })
    });
    const lark = createLarkResponder();
    vi.mocked(lark.sendCardToChatId).mockResolvedValueOnce({
      messageId: "card_oc_group_1",
      raw: {}
    });
    vi.mocked(lark.replyText)
      .mockResolvedValueOnce({
        messageId: "reply_fork_intro_1",
        raw: { data: { thread_id: "topic_fork_1" } }
      })
      .mockResolvedValueOnce({
        messageId: "reply_fork_1",
        raw: { data: { thread_id: "topic_fork_1" } }
      });
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_fork", "/fork try alternate path", {
      senderOpenId: "ou_guest"
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.forkThread).toHaveBeenCalledWith({
      role: "owner",
      threadId: "thread_group",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never"
    });
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(codex.resumeThread).toHaveBeenCalledWith({
      role: "owner",
      threadId: "thread_forked",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never"
    });
    expect(lark.sendCardToChatId).toHaveBeenCalledWith("oc_group", expect.any(Object), {
      uuid: expect.stringMatching(UUID_PATTERN)
    });
    expect(lark.replyText).toHaveBeenNthCalledWith(
      1,
      "card_oc_group_1",
      '话题由 <at user_id="ou_guest">Guest User</at> 创建，分叉自 thread_group',
      { replyInThread: true }
    );
    expect(lark.replyText).toHaveBeenNthCalledWith(
      2,
      "card_oc_group_1",
      "try alternate path",
      { replyInThread: true }
    );
    expect(lark.recallMessage).toHaveBeenCalledWith("g_fork");
    expect(repository.getCodexThreadById("thread_forked")).toMatchObject({
      codexThreadId: "thread_forked",
      conversationKey: "group_oc_group",
      name: "try alternate path",
      larkThreadId: "topic_fork_1",
      role: "owner",
      forkedFromCodexThreadId: "thread_group",
      codexThreadHasRollout: true
    });
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "reply_fork_1",
        eventId: "thread_reply:e_g_fork",
        larkThreadId: "topic_fork_1",
        routeKind: "message",
        status: "processing",
        text: "try alternate path"
      })
    );
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_forked",
        input: wrappedMessage("try alternate path", "reply_fork_1", "ou_guest")
      })
    );
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g_fork"]);
  });

  it("uses the default branch title for an empty /fork topic", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      forkThread: vi.fn(async () => ({ threadId: "thread_forked_empty" }))
    });
    const lark = createLarkResponder();
    vi.mocked(lark.sendCardToChatId).mockResolvedValueOnce({
      messageId: "card_oc_group_1",
      raw: { data: { thread_id: "topic_fork_empty" } }
    });
    vi.mocked(lark.replyText).mockResolvedValueOnce({
      messageId: "reply_fork_empty_intro_1",
      raw: { data: { thread_id: "topic_fork_empty" } }
    });
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_fork_empty", "/fork", {
      senderOpenId: "ou_guest"
    }));

    await waitForExpect(() => expect(lark.sendCardToChatId).toHaveBeenCalledTimes(1));
    expect(lark.sendCardToChatId).toHaveBeenCalledWith(
      "oc_group",
      expect.objectContaining({
        header: expect.objectContaining({
          title: { tag: "plain_text", content: "新分支会话" }
        })
      }),
      { uuid: expect.stringMatching(UUID_PATTERN) }
    );
    await waitForExpect(() =>
      expect(repository.getCodexThreadById("thread_forked_empty")).toMatchObject({
        name: "新分支会话",
        forkedFromCodexThreadId: "thread_group"
      })
    );
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g_fork_empty"]);
  });

  it("allows /fork inside a Lark thread and forks that topic's Codex thread", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row, {
      codexThreads: [
        codexThreadRecord({
          id: 2,
          codexThreadId: "thread_topic_source",
          conversationKey: "group_oc_group",
          larkThreadId: "topic_source",
          role: "owner",
          codexThreadHasRollout: true
        })
      ]
    });
    const codex = createCodex({
      forkThread: vi.fn(async () => ({ threadId: "thread_topic_fork" }))
    });
    const lark = createLarkResponder();
    vi.mocked(lark.sendCardToChatId).mockResolvedValueOnce({
      messageId: "card_oc_group_1",
      raw: {}
    });
    vi.mocked(lark.replyText)
      .mockResolvedValueOnce({
        messageId: "reply_topic_fork_intro_1",
        raw: { data: { thread_id: "topic_fork_nested" } }
      })
      .mockResolvedValueOnce({
        messageId: "reply_topic_fork_1",
        raw: { data: { thread_id: "topic_fork_nested" } }
      });
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_fork_nested", "/fork nested work", {
      chatType: "topic_group",
      larkThreadId: "topic_source",
      senderOpenId: "ou_guest"
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(repository.getCodexThreadByConversationAndLarkThread).toHaveBeenCalledWith(
      "group_oc_group",
      "topic_source"
    );
    expect(codex.forkThread).toHaveBeenCalledWith({
      role: "owner",
      threadId: "thread_topic_source",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never"
    });
    expect(lark.sendCardToChatId).toHaveBeenCalledWith("oc_group", expect.any(Object), {
      uuid: expect.stringMatching(UUID_PATTERN)
    });
    expect(lark.replyText).toHaveBeenNthCalledWith(
      1,
      "card_oc_group_1",
      '话题由 <at user_id="ou_guest">Guest User</at> 创建，分叉自 thread_topic_source',
      { replyInThread: true }
    );
    expect(lark.forwardThreadToThread).toHaveBeenCalledWith("topic_fork_nested", "topic_source", {
      uuid: expect.stringMatching(UUID_PATTERN)
    });
    expect(lark.recallMessage).not.toHaveBeenCalledWith("g_fork_nested");
    expect(repository.getCodexThreadById("thread_topic_fork")).toMatchObject({
      larkThreadId: "topic_fork_nested",
      forkedFromCodexThreadId: "thread_topic_source",
      codexThreadHasRollout: true
    });
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_topic_fork",
        input: wrappedMessage("nested work", "reply_topic_fork_1", "ou_guest")
      })
    );
  });

  it("runs /side as an ephemeral default-mode turn with a numbered temporary card", async () => {
    const sideTurn = deferred<CodexTurnResult>();
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_1",
          conversationKey: "p2p_ou_guest",
          role: "guest",
          mode: "plan"
        })
      ]
    });
    const codex = createCodex({
      forkThread: vi.fn(async () => ({ threadId: "thread_1_side_1" })),
      startTurn: vi.fn((params) => {
        void params.onTurnStarted?.("side_turn_1");
        return sideTurn.promise;
      })
    });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m_side", "/side /plan inspect this"));

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    expect(codex.forkThread).toHaveBeenCalledWith({
      role: "guest",
      threadId: "thread_1",
      cwd: "/tmp/twinny/workspaces/p2p_ou_guest",
      approvalPolicy: "never",
      ephemeral: true,
      developerInstructions: expect.stringContaining("You are in a side conversation"),
      model: undefined,
      effort: undefined
    });
    expect(codex.injectThreadItems).toHaveBeenCalledWith({
      role: "guest",
      threadId: "thread_1_side_1",
      items: [
        expect.objectContaining({
          type: "message",
          role: "user",
          content: [
            expect.objectContaining({
              type: "input_text",
              text: expect.stringContaining("Side conversation boundary")
            })
          ]
        })
      ]
    });
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "guest",
        threadId: "thread_1_side_1",
        mode: "default",
        input: wrappedMessage("/plan inspect this", "m_side")
      })
    );
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "m_side",
        routeKind: "side_message",
        status: "processing",
        text: "/plan inspect this"
      })
    );
    expect(repository.updateLarkMessageSideMetadata).toHaveBeenCalledWith("m_side", { sideId: 1 });
    expect(repository.updateLarkMessageSideMetadata).toHaveBeenCalledWith("m_side", {
      agentCardMessageId: "card_m_side_1"
    });
    expect(repository.markLarkMessagesProcessing).toHaveBeenCalledWith(["m_side"], {
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_1_side_1"
    });
    expect(repository.markLarkMessagesProcessing).toHaveBeenCalledWith(["m_side"], {
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_1_side_1",
      codexTurnId: "side_turn_1"
    });
    expect(repository.upsertCodexThread).toHaveBeenCalledWith({
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_1_side_1",
      role: "guest"
    });
    expect(repository.updateCodexThreadMode).not.toHaveBeenCalled();
    expect(repository.updateCodexThreadTokenUsage).not.toHaveBeenCalled();

    const workingCard = vi.mocked(lark.replyCard).mock.calls[0]![1] as Record<string, unknown>;
    expect(workingCard).toMatchObject({
      header: {
        subtitle: { tag: "plain_text", content: "临时会话 [1]" }
      }
    });
    const serializedCard = JSON.stringify(workingCard);
    expect(serializedCard).toContain("打断");
    expect(serializedCard).not.toContain("开启排队");
    expect(serializedCard).not.toContain("排队模式");

    sideTurn.resolve(completed("thread_1_side_1", "side_turn_1"));
    await waitForExpect(() =>
      expect(lark.patchCard).toHaveBeenCalledWith(
        "card_m_side_1",
        expect.objectContaining({
          header: expect.objectContaining({
            template: "green",
            title: { tag: "plain_text", content: "已完成" },
            subtitle: { tag: "plain_text", content: "临时会话" }
          })
        })
      )
    );
    await waitForExpect(() => expect(codex.unsubscribeThread).toHaveBeenCalledWith({
      role: "guest",
      threadId: "thread_1_side_1"
    }));
    expect(lark.replyCard).toHaveBeenCalledTimes(1);
    expect(lark.getMessageReadOpenIds).not.toHaveBeenCalled();
    expect(lark.recallMessage).not.toHaveBeenCalledWith("card_m_side_1");
  });

  it("switches a side turn to a goal card only after a passive Codex goal notification", async () => {
    const sideTurn = deferred<CodexTurnResult>();
    const { repository } = createRepository(conversationRecord());
    const codex = createCodex({
      forkThread: vi.fn(async () => ({ threadId: "thread_1_side_goal" })),
      startTurn: vi.fn((params) => {
        void params.onTurnStarted?.("side_goal_turn_1");
        return sideTurn.promise;
      })
    });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m_side_goal", "/side inspect passive goal"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await vi.mocked(codex.startTurn).mock.calls[0]![0].onGoalUpdated?.({
      threadId: "thread_1_side_goal",
      objective: "side passive goal",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 2
    }, "side_goal_turn_1");

    await waitForExpect(() => {
      const patched = vi.mocked(lark.patchCard).mock.calls.find(([, card]) =>
        JSON.stringify(card).includes("实现目标中：side passive goal")
      )?.[1];
      expect(patched).toMatchObject({
        header: expect.objectContaining({
          title: { tag: "plain_text", content: "实现目标中：side passive goal" },
          subtitle: { tag: "plain_text", content: "临时会话 [1]" }
        })
      });
    });
    expect(repository.updateCodexThreadGoalStatus).toHaveBeenCalledWith({
      codexThreadId: "thread_1_side_goal",
      goalStatus: "active",
      goalUpdatedAt: 2
    });
    expect(codex.runGoal).not.toHaveBeenCalled();

    sideTurn.resolve(completed("thread_1_side_goal", "side_goal_turn_1", "interrupted"));
    await waitForExpect(() => expect(repository.markLarkMessagesFailed).toHaveBeenCalledWith(["m_side_goal"]));
  });

  it("allocates the smallest free side id and releases it after completion", async () => {
    const { repository } = createRepository(conversationRecord());
    const { codex, turns } = createDeferredCodex();
    let forkCount = 0;
    vi.mocked(codex.forkThread).mockImplementation(async ({ threadId }) => ({
      threadId: `${threadId}_side_${++forkCount}`
    }));
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m_side_1", "/side first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m_side_2", "/btw second"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));

    expect(repository.updateLarkMessageSideMetadata).toHaveBeenCalledWith("m_side_1", { sideId: 1 });
    expect(repository.updateLarkMessageSideMetadata).toHaveBeenCalledWith("m_side_2", { sideId: 2 });

    turns[0]!.resolve(completed("thread_1_side_1", "turn_1"));
    await waitForExpect(() => expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m_side_1"]));
    await waitForExpect(() => expect(codex.unsubscribeThread).toHaveBeenCalledWith({
      role: "guest",
      threadId: "thread_1_side_1"
    }));

    manager.submitIncoming(message("m_side_3", "/side third"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(3));
    expect(repository.updateLarkMessageSideMetadata).toHaveBeenCalledWith("m_side_3", { sideId: 1 });

    turns[1]!.resolve(completed("thread_1_side_2", "turn_2"));
    turns[2]!.resolve(completed("thread_1_side_3", "turn_3"));
  });

  it("stops a numbered side turn without interrupting the main turn", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    vi.mocked(codex.forkThread).mockResolvedValue({ threadId: "thread_1_side" });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m_main", "main work"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m_side", "/side inspect"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));

    manager.submitIncoming(message("m_stop_side", "/stop 1"));

    await waitForExpect(() =>
      expect(codex.interruptTurn).toHaveBeenCalledWith(expect.objectContaining({
        role: "guest",
        threadId: "thread_1_side",
        turnId: "turn_2"
      }))
    );
    expect(codex.interruptTurn).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread_1", turnId: "turn_1" })
    );
    expect(repository.markLarkMessagesInterrupted).toHaveBeenCalledWith(["m_side"]);
    expect(repository.markLarkMessagesInterrupted).not.toHaveBeenCalledWith(["m_main"]);
    expect(lark.replyText).toHaveBeenCalledWith("m_stop_side", "已停止临时会话 [1]。");

    turns[1]!.resolve(completed("thread_1_side", "turn_2", "interrupted"));
    turns[0]!.resolve(completed("thread_1", "turn_1"));
  });

  it("stops every running side turn on /stop all", async () => {
    const { repository } = createRepository(groupConversationRecord({ role: "guest" }));
    const { codex, turns } = createDeferredCodex();
    let forkCount = 0;
    vi.mocked(codex.forkThread).mockImplementation(async ({ threadId }) => ({
      threadId: `${threadId}_side_${++forkCount}`
    }));
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_side_1", "/side first", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(groupMessage("g_side_2", "/side second", { senderOpenId: "ou_other" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));

    manager.submitIncoming(groupMessage("g_stop_all", "/stop all", { senderOpenId: "ou_third" }));

    await waitForExpect(() => expect(codex.interruptTurn).toHaveBeenCalledTimes(2));
    expect(codex.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "guest", threadId: "thread_group_side_1", turnId: "turn_1" })
    );
    expect(codex.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "guest", threadId: "thread_group_side_2", turnId: "turn_2" })
    );
    expect(repository.markLarkMessagesInterrupted).toHaveBeenCalledWith(["g_side_1"]);
    expect(repository.markLarkMessagesInterrupted).toHaveBeenCalledWith(["g_side_2"]);
    expect(lark.replyText).toHaveBeenCalledWith(
      "g_stop_all",
      "已停止当前任务，清空 0 条待处理消息，停止 2 个临时会话。当前没有正在运行的主任务。"
    );

    turns[0]!.resolve(completed("thread_group_side_1", "turn_1", "interrupted"));
    turns[1]!.resolve(completed("thread_group_side_2", "turn_2", "interrupted"));
  });

  it("rejects /side nested under /thread or /fork", async () => {
    const { repository } = createRepository(groupConversationRecord({ role: "owner" }));
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_thread_side", "/thread /side no"));
    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("g_thread_side", "side 只能作为最外层指令使用。")
    );

    manager.submitIncoming(groupMessage("g_fork_side", "/fork /side no"));
    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("g_fork_side", "side 只能作为最外层指令使用。")
    );
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(codex.forkThread).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
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
    vi.mocked(lark.replyText)
      .mockResolvedValueOnce({
        messageId: "reply_thread_intro_1",
        raw: { data: { thread_id: "topic_thread_1" } }
      })
      .mockResolvedValueOnce({ messageId: "reply_thread_1" });
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_thread_mention", "/thread hi @_user_1", {
      senderOpenId: "ou_guest",
      mentions: [{ key: "@_user_1", openId: "ou_alice", name: "Alice" }]
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(lark.replyText).toHaveBeenNthCalledWith(
      1,
      "card_oc_group_1",
      '话题由 <at user_id="ou_guest">Guest User</at> 创建',
      { replyInThread: true }
    );
    expect(lark.replyText).toHaveBeenNthCalledWith(
      2,
      "card_oc_group_1",
      "hi <at user_id=\"ou_alice\">Alice</at>",
      { replyInThread: true }
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
    vi.mocked(lark.replyText).mockResolvedValueOnce({
      messageId: "reply_thread_intro_1",
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
    expect(lark.replyText).toHaveBeenCalledWith(
      "card_oc_group_1",
      '话题由 <at user_id="ou_guest">Guest User</at> 创建',
      { replyInThread: true }
    );
    expect(lark.replyPost).toHaveBeenCalledWith(
      "card_oc_group_1",
      [
        [
          { tag: "text", text: "post hi " },
          { tag: "at", user_id: "ou_alice", user_name: "Alice" }
        ],
        [{ tag: "text", text: "second line" }]
      ],
      { replyInThread: true }
    );
    expect(lark.recallMessage).toHaveBeenCalledWith("g_thread_post");
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: wrappedMessage("post hi @Alice\nsecond line", "reply_post_1", "ou_guest")
      })
    );
  });

  it("preserves /thread post image resources in the proxy reply and Codex input", async () => {
    const row = groupConversationRecord({ role: "owner", responseMode: "at" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_post_image" })),
      startTurn: vi.fn(async ({ threadId }) => completed(threadId, "turn_1"))
    });
    const lark = createLarkResponder();
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(async ({ outputDir }) => ({
        path: `${outputDir}/img_1.jpg`,
        resourceType: "image" as const,
        fileKey: "img_1",
        fileName: "img_1.jpg",
        size: 111,
        contentType: "image/jpeg"
      })),
      uploadImage: vi.fn(async () => ({ imageKey: "img_uploaded_1" }))
    };
    vi.mocked(lark.sendCardToChatId).mockResolvedValueOnce({
      messageId: "card_oc_group_1",
      raw: { data: { thread_id: "topic_thread_1" } }
    });
    vi.mocked(lark.replyText).mockResolvedValueOnce({
      messageId: "reply_thread_intro_1",
      raw: { data: { thread_id: "topic_thread_1" } }
    });
    vi.mocked(lark.replyPost).mockResolvedValueOnce({ messageId: "reply_post_image_1" });
    const manager = createManager({ repository, codex, lark, larkFiles });

    manager.submitIncoming(groupMessage("g_thread_post_image", "/thread see {{TWINNY_LARK_RESOURCE_0}} done", {
      messageType: "post",
      senderOpenId: "ou_guest",
      resources: [
        {
          resourceType: "image",
          fileKey: "img_1",
          codexTag: "img",
          textPlaceholder: "{{TWINNY_LARK_RESOURCE_0}}"
        }
      ]
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(larkFiles.uploadImage).toHaveBeenCalledWith({
      filePath: "/tmp/twinny/workspaces/group_oc_group/.twinny/lark_files/g_thread_post_image/img_1.jpg",
      fileName: "img_1.jpg",
      contentType: "image/jpeg"
    });
    expect(lark.replyText).toHaveBeenCalledWith(
      "card_oc_group_1",
      '话题由 <at user_id="ou_guest">Guest User</at> 创建',
      { replyInThread: true }
    );
    expect(lark.replyPost).toHaveBeenCalledWith(
      "card_oc_group_1",
      [
        [
          { tag: "text", text: "see " },
          { tag: "img", image_key: "img_uploaded_1" },
          { tag: "text", text: " done" }
        ]
      ],
      { replyInThread: true }
    );
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text:
              '<lark_message lark_message_id="reply_post_image_1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
              'see <img path="/tmp/twinny/workspaces/group_oc_group/.twinny/lark_files/g_thread_post_image/img_1.jpg" lark_file_key="img_1" size="111">',
            text_elements: []
          },
          {
            type: "localImage",
            path: "/tmp/twinny/workspaces/group_oc_group/.twinny/lark_files/g_thread_post_image/img_1.jpg",
            detail: null
          },
          {
            type: "text",
            text: "</img> done\n</lark_message>",
            text_elements: []
          }
        ]
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

  it("allows /thread inside Lark thread contexts and forwards the new topic back", async () => {
    const row = groupConversationRecord({ responseMode: "all" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_nested" })),
      startTurn: vi.fn(async ({ threadId }) => completed(threadId, "turn_1"))
    });
    const lark = createLarkResponder();
    vi.mocked(lark.sendCardToChatId).mockResolvedValueOnce({
      messageId: "card_oc_group_1",
      raw: { data: { thread_id: "topic_nested_new" } }
    });
    vi.mocked(lark.replyText)
      .mockResolvedValueOnce({
        messageId: "reply_nested_intro_1",
        raw: { data: { thread_id: "topic_nested_new" } }
      })
      .mockResolvedValueOnce({
        messageId: "reply_nested_1",
        raw: { data: { thread_id: "topic_nested_new" } }
      });
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_thread_nested", "/thread nested", {
      chatType: "topic_group",
      larkThreadId: "topic_source"
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(lark.sendCardToChatId).toHaveBeenCalledWith("oc_group", expect.any(Object), {
      uuid: expect.stringMatching(UUID_PATTERN)
    });
    expect(lark.replyText).toHaveBeenNthCalledWith(
      1,
      "card_oc_group_1",
      '话题由 <at user_id="ou_guest">Guest User</at> 创建',
      { replyInThread: true }
    );
    expect(lark.replyText).toHaveBeenNthCalledWith(2, "card_oc_group_1", "nested", { replyInThread: true });
    expect(lark.forwardThreadToThread).toHaveBeenCalledWith("topic_nested_new", "topic_source", {
      uuid: expect.stringMatching(UUID_PATTERN)
    });
    expect(lark.recallMessage).not.toHaveBeenCalledWith("g_thread_nested");
    expect(repository.getCodexThreadById("thread_nested")).toMatchObject({
      larkThreadId: "topic_nested_new"
    });
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_nested",
        input: wrappedMessage("nested", "reply_nested_1", "ou_guest")
      })
    );
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g_thread_nested"]);
  });

  it("lets p2p users create a Lark thread with /thread", async () => {
    const row = conversationRecord({ codexThreadId: "thread_main" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_dm_topic" })),
      startTurn: vi.fn(async ({ threadId }) => completed(threadId, "turn_1"))
    });
    const lark = createLarkResponder();
    vi.mocked(lark.replyCard).mockResolvedValueOnce({
      messageId: "card_dm_thread_1",
      raw: { data: { thread_id: "dm_thread_1" } }
    });
    vi.mocked(lark.replyText)
      .mockResolvedValueOnce({
        messageId: "reply_dm_thread_intro_1",
        raw: { data: { thread_id: "dm_thread_1" } }
      })
      .mockResolvedValueOnce({
        messageId: "reply_dm_thread_1",
        raw: { data: { thread_id: "dm_thread_1" } }
      });
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m_thread", "/thread hello", { senderOpenId: "ou_guest" }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(lark.replyCard).toHaveBeenCalledWith("m_thread", expect.any(Object), { replyInThread: true });
    expect(lark.replyText).toHaveBeenNthCalledWith(
      1,
      "card_dm_thread_1",
      '话题由 <at user_id="ou_guest">Guest User</at> 创建',
      { replyInThread: true }
    );
    expect(lark.replyText).toHaveBeenNthCalledWith(2, "card_dm_thread_1", "hello", { replyInThread: true });
    expect(lark.sendCardToChatId).not.toHaveBeenCalled();
    expect(lark.recallMessage).toHaveBeenCalledWith("card_reply_dm_thread_1_1");
    expect(repository.updateCodexThreadCard).toHaveBeenLastCalledWith({
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_dm_topic",
      role: "guest",
      name: "hello",
      larkThreadId: "dm_thread_1",
      creatorOpenId: "ou_guest",
      cardMessageId: "card_dm_thread_1"
    });
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "reply_dm_thread_1",
        eventId: "thread_reply:e_m_thread",
        larkUserId: "ou_guest",
        larkGroupId: undefined,
        larkThreadId: "dm_thread_1",
        conversationKey: "p2p_ou_guest",
        routeKind: "message",
        status: "processing",
        text: "hello"
      })
    );
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_dm_topic",
        input: wrappedMessage("hello", "reply_dm_thread_1", "ou_guest")
      })
    );
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
    await waitForExpect(() =>
      expect(lark.sendEphemeralCardToChatId).toHaveBeenCalledWith("oc_group", "ou_guest", expect.any(Object))
    );
    expect(JSON.stringify(vi.mocked(lark.sendEphemeralCardToChatId).mock.calls[0]![2])).toContain("仅 at");
    expect(lark.replyCard).not.toHaveBeenCalled();
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
        input: [
          {
            type: "text",
            text:
              '<lark_message lark_message_id="m1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
              "Please inspect\n\n" +
              '<img path="/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m1/img_1.jpg" lark_file_key="img_1" size="111">',
            text_elements: []
          },
          {
            type: "localImage",
            path: "/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m1/img_1.jpg",
            detail: null
          },
          {
            type: "text",
            text:
              "</img>\n\n" +
              '<video path="/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m1/file_1.mp4" lark_file_key="file_1" size="222">Saved locally</video>\n' +
              "</lark_message>",
            text_elements: []
          }
        ]
      })
    );
  });

  it("replaces downloaded interactive card resources with file path XML without local image inputs", async () => {
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
      message("m1", "<card title=\"Card\">\nAlpha\n{{TWINNY_LARK_RESOURCE_0}}\n{{TWINNY_LARK_RESOURCE_1}}\n</card>", {
        messageType: "interactive",
        resources: [
          {
            resourceType: "image",
            fileKey: "img_card",
            codexTag: "file",
            textPlaceholder: "{{TWINNY_LARK_RESOURCE_0}}"
          },
          {
            resourceType: "file",
            fileKey: "file_card",
            codexTag: "file",
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
          '<card title="Card">\n' +
          "Alpha\n" +
          '<file path="/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m1/img_card.jpg" lark_file_key="img_card" size="111">Saved locally</file>\n' +
          '<file path="/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m1/file_card.mp4" lark_file_key="file_card" size="222">Saved locally</file>\n' +
          "</card>\n" +
          "</lark_message>"
      })
    );
  });

  it("forwards unsupported Lark message types to Codex with raw metadata", async () => {
    const codex = createCodex();
    const manager = createManager({ codex });
    const rawMessage = JSON.stringify({
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

  it("expands merge-forward messages from Lark get items before submitting to Codex", async () => {
    const codex = createCodex();
    const larkUsers: LarkUserDirectory = {
      getUserNameByOpenId: vi.fn(async (openId) => openId === "ou_child" ? "Child User" : "Guest User")
    };
    const larkChats: LarkChatDirectory = {
      getChatInfo: vi.fn(async () => ({ name: "Source Chat", chatMode: "group" as const }))
    };
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(async ({ outputDir, fileKey }) => ({
        path: `${outputDir}/${fileKey}.jpg`,
        resourceType: "image" as const,
        fileKey,
        size: 123,
        contentType: "image/jpeg"
      }))
    };
    const larkMessages: LarkMessageReader = {
      getMessage: vi.fn(),
      getMessageItems: vi.fn(async () => [
        { message_id: "mf1", msg_type: "merge_forward", deleted: false, body: { content: "Merged and Forwarded Message" } },
        {
          message_id: "child_text",
          upper_message_id: "mf1",
          msg_type: "text",
          chat_id: "oc_source",
          create_time: "111",
          sender: { id: "ou_child", id_type: "open_id", sender_type: "user" },
          body: { content: JSON.stringify({ text: "hello from child" }) }
        },
        {
          message_id: "child_image",
          upper_message_id: "mf1",
          msg_type: "image",
          chat_id: "oc_source",
          create_time: "112",
          sender: { id: "cli_app", id_type: "app_id", sender_type: "app" },
          body: { content: JSON.stringify({ image_key: "img_1" }) }
        }
      ])
    };
    const manager = createManager({ codex, larkUsers, larkChats, larkFiles, larkMessages });

    manager.submitIncoming(message("mf1", "Merged and Forwarded Message", {
      messageType: "merge_forward",
      rawForCodex: true
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(larkMessages.getMessageItems).toHaveBeenCalledWith("mf1");
    expect(larkChats.getChatInfo).toHaveBeenCalledWith("oc_source");
    expect(larkFiles.downloadMessageResource).toHaveBeenCalledWith({
      messageId: "mf1",
      resourceType: "image",
      fileKey: "img_1",
      fileName: undefined,
      outputDir: "/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files"
    });
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input:
          '<lark_message lark_message_id="mf1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
          '<merge_forward source_chat_id="oc_source" source_chat_type="group" source_chat_name="Source Chat">\n' +
          '<lark_message lark_message_id="child_text" timestamp="111" message_type="text" sender_id="ou_child" sender_ouid="ou_child" sender_id_type="open_id" sender_type="user" sender_name="Child User">\n' +
          "hello from child\n" +
          "</lark_message>\n" +
          '<lark_message lark_message_id="child_image" timestamp="112" message_type="image" sender_id="cli_app" sender_id_type="app_id" sender_type="app">\n' +
          '<file path="/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/img_1.jpg" lark_file_key="img_1" size="123">Saved locally</file>\n' +
          "</lark_message>\n" +
          "</merge_forward>\n" +
          "</lark_message>"
      })
    );
  });

  it("expands interactive card children inside merge-forward messages", async () => {
    const codex = createCodex();
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(async ({ outputDir, fileKey }) => ({
        path: `${outputDir}/${fileKey}.jpg`,
        resourceType: "image" as const,
        fileKey,
        size: 123,
        contentType: "image/jpeg"
      }))
    };
    const larkMessages: LarkMessageReader = {
      getMessage: vi.fn(),
      getMessageItems: vi.fn(async () => [
        { message_id: "mf1", msg_type: "merge_forward", deleted: false, body: { content: "Merged and Forwarded Message" } },
        {
          message_id: "child_card",
          upper_message_id: "mf1",
          msg_type: "interactive",
          chat_id: "oc_source",
          create_time: "111",
          sender: { id: "cli_app", id_type: "app_id", sender_type: "app" },
          body: {
            content: JSON.stringify({
              schema: "2.0",
              header: { title: { tag: "plain_text", content: "Child Card" } },
              body: {
                elements: [
                  { tag: "markdown", content: "Card child" },
                  { tag: "img", img_key: "img_child" }
                ]
              }
            })
          }
        }
      ])
    };
    const manager = createManager({ codex, larkFiles, larkMessages });

    manager.submitIncoming(message("mf1", "Merged and Forwarded Message", {
      messageType: "merge_forward",
      rawForCodex: true
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(larkFiles.downloadMessageResource).toHaveBeenCalledWith({
      messageId: "mf1",
      resourceType: "image",
      fileKey: "img_child",
      fileName: undefined,
      outputDir: "/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files"
    });
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input:
          '<lark_message lark_message_id="mf1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
          '<merge_forward source_chat_id="oc_source">\n' +
          '<lark_message lark_message_id="child_card" timestamp="111" message_type="interactive" sender_id="cli_app" sender_id_type="app_id" sender_type="app">\n' +
          '<card title="Child Card">\n' +
          "Card child\n" +
          '<file path="/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/img_child.jpg" lark_file_key="img_child" size="123">Saved locally</file>\n' +
          "</card>\n" +
          "</lark_message>\n" +
          "</merge_forward>\n" +
          "</lark_message>"
      })
    );
  });

  it("keeps merge-forward content when child resource download fails", async () => {
    const codex = createCodex();
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(async () => {
        throw new Error("download failed");
      })
    };
    const larkMessages: LarkMessageReader = {
      getMessage: vi.fn(),
      getMessageItems: vi.fn(async () => [
        { message_id: "mf1", msg_type: "merge_forward", deleted: false, body: { content: "Merged and Forwarded Message" } },
        {
          message_id: "child_post",
          upper_message_id: "mf1",
          msg_type: "post",
          chat_id: "oc_source",
          create_time: "111",
          sender: { id: "ou_child", id_type: "open_id", sender_type: "user" },
          body: {
            content: JSON.stringify({
              content: [[
                { tag: "text", text: "before " },
                { tag: "img", image_key: "img_fail" },
                { tag: "text", text: " after" }
              ]]
            })
          }
        }
      ])
    };
    const manager = createManager({ codex, larkFiles, larkMessages });

    manager.submitIncoming(message("mf1", "Merged and Forwarded Message", {
      messageType: "merge_forward",
      rawForCodex: true
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(larkFiles.downloadMessageResource).toHaveBeenCalledWith({
      messageId: "mf1",
      resourceType: "image",
      fileKey: "img_fail",
      fileName: undefined,
      outputDir: "/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files"
    });
    const input = (codex.startTurn as Mock).mock.calls[0]?.[0].input as string;
    expect(input).toContain("<merge_forward");
    expect(input).toContain('before <img filekey="img_fail">Download failed</img> after');
    expect(input).toContain("</merge_forward>");
    expect(input).not.toContain('{"message_type":"merge_forward"');
  });

  it("omits merge-forward name attributes when user or chat lookup fails", async () => {
    const codex = createCodex();
    const larkUsers: LarkUserDirectory = {
      getUserNameByOpenId: vi.fn(async () => {
        throw new Error("contact unavailable");
      })
    };
    const larkChats: LarkChatDirectory = {
      getChatInfo: vi.fn(async () => {
        throw new Error("chat unavailable");
      })
    };
    const larkMessages: LarkMessageReader = {
      getMessage: vi.fn(),
      getMessageItems: vi.fn(async () => [
        { message_id: "mf1", msg_type: "merge_forward", deleted: false, body: { content: "Merged and Forwarded Message" } },
        {
          message_id: "child_text",
          upper_message_id: "mf1",
          msg_type: "text",
          chat_id: "oc_source",
          create_time: "111",
          sender: { id: "ou_child", id_type: "open_id", sender_type: "user" },
          body: { content: JSON.stringify({ text: "hello" }) }
        }
      ])
    };
    const manager = createManager({ codex, larkUsers, larkChats, larkMessages });

    manager.submitIncoming(message("mf1", "Merged and Forwarded Message", {
      messageType: "merge_forward",
      rawForCodex: true
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    const input = (codex.startTurn as Mock).mock.calls[0]?.[0].input as string;
    expect(input).toContain('<merge_forward source_chat_id="oc_source">');
    expect(input).not.toContain("source_chat_name=");
    expect(input).not.toContain("source_chat_type=");
    expect(input).not.toContain('sender_name="Child User"');
  });

  it("applies merge-forward child and global content limits", async () => {
    const codex = createCodex();
    const children = Array.from({ length: 33 }, (_, index) => ({
      message_id: `child_${index}`,
      upper_message_id: "mf1",
      msg_type: "text",
      chat_id: "oc_source",
      create_time: String(100 + index),
      sender: { id: "cli_app", id_type: "app_id", sender_type: "app" },
      body: { content: JSON.stringify({ text: index === 0 ? "x".repeat(2050) : `child ${index}` }) }
    }));
    const larkMessages: LarkMessageReader = {
      getMessage: vi.fn(),
      getMessageItems: vi.fn(async () => [
        { message_id: "mf1", msg_type: "merge_forward", deleted: false, body: { content: "Merged and Forwarded Message" } },
        ...children
      ])
    };
    const manager = createManager({ codex, larkMessages });

    manager.submitIncoming(message("mf1", "Merged and Forwarded Message", {
      messageType: "merge_forward",
      rawForCodex: true
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    const input = (codex.startTurn as Mock).mock.calls[0]?.[0].input as string;
    expect(input).toContain('lark_message_id="child_0"');
    expect(input).toContain('omitted="true" omitted_reason="message_content_too_large"');
    expect(input).not.toContain('lark_message_id="child_32"');
    expect(input).toContain("已省略 1 条合并转发消息，原因是数量或总长度超过限制。");
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
    vi.mocked(lark.replyCard).mockRejectedValue(new Error("card unavailable"));
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyMarkdown).toHaveBeenCalledWith("m1", "reply"));

    expect(row.codexThreadId).toBe("thread_replacement");
    expect(codex.startTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread_replacement" }));
    expect(lark.replyText).toHaveBeenNthCalledWith(1, "m1", expect.stringMatching(/^WARN: .*previous context/));
  });

  it("replaces a missing thread when Codex rejects turn start", async () => {
    const row = conversationRecord({ codexThreadId: "thread_missing" });
    const { repository } = createRepository(row, { mainThreadHasRollout: false });
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_replacement" })),
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        if (threadId === "thread_missing") {
          throw new TwinnyError("thread not found: thread_missing", "CODEX_REQUEST_FAILED", {
            code: -32600,
            message: "thread not found: thread_missing"
          });
        }
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({ id: "agent_1", text: "reply" });
        return completed(threadId, "turn_1");
      })
    });
    const lark = createLarkResponder();
    vi.mocked(lark.replyCard).mockRejectedValue(new Error("card unavailable"));
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyMarkdown).toHaveBeenCalledWith("m1", "reply"));

    expect(row.codexThreadId).toBe("thread_replacement");
    expect(codex.resumeThread).not.toHaveBeenCalled();
    expect(codex.startTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({ threadId: "thread_missing" }));
    expect(codex.startTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ threadId: "thread_replacement" }));
    expect(repository.getCodexThreadById("thread_replacement")).toMatchObject({ codexThreadHasRollout: true });
    expect(repository.markLarkMessagesFailed).not.toHaveBeenCalled();
    expect(lark.replyText).toHaveBeenNthCalledWith(1, "m1", expect.stringMatching(/^WARN: .*previous context/));
  });

  it("falls back to plain agentMessage items when agent cards cannot be sent", async () => {
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
    vi.mocked(lark.replyCard).mockRejectedValue(new Error("card unavailable"));
    const manager = createManager({ codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyMarkdown).toHaveBeenCalledTimes(2));

    expect(lark.replyMarkdown).toHaveBeenNthCalledWith(1, "m1", "first item");
    expect(lark.replyMarkdown).toHaveBeenNthCalledWith(2, "m1", "second item");
    expect(lark.replyMarkdown).not.toHaveBeenCalledWith("m1", "final aggregate should not be sent");
    expect(lark.addCompletedReaction).not.toHaveBeenCalled();
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

  it("renders compact cards with fixed progress and completion text", async () => {
    const { codex, compacts } = createDeferredCompactCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "/compact"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    const workingCard = vi.mocked(lark.replyCard).mock.calls[0]![1] as Record<string, unknown>;
    const workingSerialized = JSON.stringify(workingCard);
    expect(workingSerialized).toContain("正在压缩上下文");
    expect(workingSerialized).not.toContain("暂无进度");

    compacts[0]!.resolve(completed("thread_1", "compact_1"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(2));

    const completedCard = vi.mocked(lark.replyCard).mock.calls[1]![1] as Record<string, unknown>;
    const completedSerialized = JSON.stringify(completedCard);
    expect(completedCard).toMatchObject({
      header: expect.objectContaining({
        template: "green",
        title: { tag: "plain_text", content: "已完成" }
      })
    });
    expect(completedSerialized).toContain("完成上下文压缩");
    expect(completedSerialized).not.toContain("正在压缩上下文");
    expect(completedSerialized).not.toContain("工作过程");
  });

  it("renders goal cards with goal progress and final goal title", async () => {
    const { codex, goals } = createDeferredGoalCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "/goal 012345678901234567890123456789abcdef"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    const workingCard = vi.mocked(lark.replyCard).mock.calls[0]![1] as Record<string, unknown>;
    const workingSerialized = JSON.stringify(workingCard);
    expect(workingCard).toMatchObject({
      header: expect.objectContaining({
        title: { tag: "plain_text", content: "实现目标中：012345678901234567890123456789..." }
      })
    });
    expect(workingSerialized).toContain("[设置目标] 012345678901234567890123456789abcdef");

    await goals[0]!.params.onAgentMessage?.({ id: "goal-progress", text: "doing the goal", phase: "commentary" });
    await waitForExpect(() => {
      const patched = vi.mocked(lark.patchCard).mock.calls.find(([messageId]) => messageId === "card_m1_1")?.[1];
      expect(JSON.stringify(patched)).toContain("doing the goal");
    });

    await goals[0]!.params.onAgentMessage?.({ id: "goal-final", text: "goal final answer", phase: "final_answer" });
    await waitForExpect(() => {
      const patched = vi.mocked(lark.patchCard).mock.calls.find(([, card]) => JSON.stringify(card).includes("goal final answer"))?.[1];
      expect(JSON.stringify(patched)).toContain("实现目标中");
    });
    goals[0]!.resolve({ ...completed("thread_1", "goal_1"), text: "aggregate text" });

    await waitForExpect(() =>
      expect(lark.replyCard).toHaveBeenNthCalledWith(
        2,
        "m1",
        expect.objectContaining({
          header: expect.objectContaining({
            template: "green",
            title: { tag: "plain_text", content: "已实现目标" }
          })
        })
      )
    );
    const completedCard = vi.mocked(lark.replyCard).mock.calls[1]![1] as Record<string, unknown>;
    const completedSerialized = JSON.stringify(completedCard);
    expect(completedSerialized).toContain("goal final answer");
    expect(completedSerialized).toContain("[设置目标] 012345678901234567890123456789abcdef");
    expect(completedSerialized).toContain("doing the goal");
    expect(completedSerialized).not.toContain("aggregate text");
  });

  it("renders goal failure errors above the status line", async () => {
    const { codex, goals } = createDeferredGoalCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "/goal finish the target"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    goals[0]!.resolve({
      ...completed("thread_1", "goal_1", "failed"),
      error: "Goal ended with status blocked"
    });

    await waitForExpect(() =>
      expect(lark.patchCard).toHaveBeenCalledWith(
        "card_m1_1",
        expect.objectContaining({
          header: expect.objectContaining({
            template: "red",
            title: { tag: "plain_text", content: "发生错误" }
          })
        })
      )
    );

    const failedCard = vi.mocked(lark.patchCard).mock.calls.find(([, card]) =>
      JSON.stringify(card).includes("Goal ended with status blocked")
    )?.[1] as Record<string, unknown>;
    const bodyElements = (failedCard.body as { elements: Array<Record<string, unknown>> }).elements;
    const errorIndex = bodyElements.findIndex((element) =>
      JSON.stringify(element).includes("[ERROR] Goal ended with status blocked")
    );
    const elapsedIndex = bodyElements.findIndex((element) => JSON.stringify(element).includes("已工作"));
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(elapsedIndex).toBeGreaterThan(errorIndex);
  });

  it("switches an ordinary turn to a goal card when Codex reports a passive goal", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "start ordinary work"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await turns[0]!.params.onGoalUpdated?.({
      threadId: "thread_1",
      objective: "passive ordinary goal",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 2
    }, "turn_1");

    await waitForExpect(() => {
      const patched = vi.mocked(lark.patchCard).mock.calls.find(([, card]) =>
        JSON.stringify(card).includes("实现目标中：passive ordinary goal")
      )?.[1];
      expect(patched).toMatchObject({
        header: expect.objectContaining({
          title: { tag: "plain_text", content: "实现目标中：passive ordinary goal" }
        })
      });
    });
    expect(repository.updateCodexThreadGoalStatus).toHaveBeenCalledWith({
      codexThreadId: "thread_1",
      goalStatus: "active",
      goalUpdatedAt: 2
    });
    expect(codex.runGoal).not.toHaveBeenCalled();

    turns[0]!.resolve(completed("thread_1", "turn_1", "interrupted"));
    await waitForExpect(() => expect(repository.markLarkMessagesFailed).toHaveBeenCalledWith(["m1"]));
  });

  it("keeps a goal final answer out of the working process after the goal is complete", async () => {
    const { codex, goals } = createDeferredGoalCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "/goal calculate pi"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await goals[0]!.params.onGoalUpdated?.({
      threadId: "thread_1",
      objective: "calculate pi",
      status: "complete",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 2
    }, "goal_1");

    const patchCountBeforeFinal = vi.mocked(lark.patchCard).mock.calls.length;
    await goals[0]!.params.onAgentMessage?.({ id: "goal-final", text: "terminal goal final", phase: "final_answer" });
    expect(vi.mocked(lark.patchCard).mock.calls).toHaveLength(patchCountBeforeFinal);
    expect(JSON.stringify(vi.mocked(lark.patchCard).mock.calls)).not.toContain("terminal goal final");

    goals[0]!.resolve({ ...completed("thread_1", "goal_1"), text: "aggregate text" });
    await waitForExpect(() =>
      expect(lark.replyCard).toHaveBeenNthCalledWith(
        2,
        "m1",
        expect.objectContaining({
          header: expect.objectContaining({
            template: "green",
            title: { tag: "plain_text", content: "已实现目标" }
          })
        })
      )
    );

    const completedCard = vi.mocked(lark.replyCard).mock.calls[1]![1] as Record<string, unknown>;
    const completedSerialized = JSON.stringify(completedCard);
    expect(completedSerialized).toContain("terminal goal final");
    expect(completedSerialized).not.toContain("aggregate text");
  });

  it("updates an active goal objective with /goal and refreshes the working card", async () => {
    const { codex, goals } = createDeferredGoalCodex();
    const lark = createLarkResponder();
    const { repository } = createRepository();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "/goal calculate pi"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    manager.submitIncoming(message("m2", "/goal calculate tau"));
    await waitForExpect(() =>
      expect(codex.setThreadGoal).toHaveBeenCalledWith({
        role: "guest",
        threadId: "thread_1",
        objective: "calculate tau"
      })
    );

    expect(codex.runGoal).toHaveBeenCalledTimes(1);
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      larkMessageId: "m2",
      routeKind: "goal_message",
      status: "processing",
      text: "calculate tau"
    }));
    expect(repository.markLarkMessagesProcessing).toHaveBeenCalledWith(["m2"], {
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_1",
      codexTurnId: "goal_1"
    });
    await waitForExpect(() => expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m2"]));

    await waitForExpect(() => {
      const patched = vi.mocked(lark.patchCard).mock.calls.find(([, card]) =>
        JSON.stringify(card).includes("[已更新目标] calculate tau")
      )?.[1];
      expect(patched).toMatchObject({
        header: expect.objectContaining({
          title: { tag: "plain_text", content: "实现目标中：calculate tau" }
        })
      });
    });

    goals[0]!.resolve({ ...completed("thread_1", "goal_1"), text: "aggregate text" });
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(2));
  });

  it("updates the same user's active goal immediately even when messages are queued", async () => {
    const { codex } = createDeferredGoalCodex();
    const lark = createLarkResponder();
    const { repository } = createRepository();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "/goal calculate pi"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    manager.submitIncoming(message("m2", "/queue later work"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));

    manager.submitIncoming(message("m3", "/goal calculate tau"));
    await waitForExpect(() =>
      expect(codex.setThreadGoal).toHaveBeenCalledWith(expect.objectContaining({ objective: "calculate tau" }))
    );
    expect(manager.queueDepth("p2p_ou_guest")).toBe(1);
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      larkMessageId: "m3",
      routeKind: "goal_message",
      status: "processing",
      text: "calculate tau"
    }));

    manager.submitIncoming(message("m4", "/queue /goal queued target"));
    await waitForExpect(() => expect(repository.insertLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      larkMessageId: "m4",
      routeKind: "goal_message",
      status: "queued",
      text: "queued target"
    })));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(2));
    expect(codex.setThreadGoal).toHaveBeenCalledTimes(1);
  });

  it("updates the working agent card footer with model and current turn token usage", async () => {
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
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_1",
          conversationKey: "p2p_ou_guest",
          totalTokens: 301_000,
          inputTokens: 300_000,
          cachedInputTokens: 270_000,
          outputTokens: 1_000,
          tokenUsageJson: JSON.stringify({
            tokenUsage: {
              total: {
                totalTokens: 301_000,
                inputTokens: 300_000,
                cachedInputTokens: 270_000,
                outputTokens: 1_000
              },
              last: {
                totalTokens: 50_000
              },
              modelContextWindow: 100_000
            }
          })
        })
      ]
    });
    const manager = createManager({ repository, codex, lark, config: managerConfig });

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
      const serialized = JSON.stringify(card);
      expect(serialized).toContain("gpt-5.5 xhigh · 57% · ↑ 27 K (90% Cached) ↓ 210");
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

  it("uses runtime logo image keys for turn card headers when provided", async () => {
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({
      codex,
      lark,
      config: cardModeConfig({ iconImageKey: "img_config_logo" }),
      assetImageKeys: { logoImageKey: "img_runtime_logo" }
    });

    manager.submitIncoming(message("m1", "first"));

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalled());
    const card = vi.mocked(lark.replyCard).mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(card)).toContain("img_runtime_logo");
    expect(JSON.stringify(card)).not.toContain("img_config_logo");
  });

  it("omits turn card header logo when runtime logo image key is unavailable", async () => {
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({
      codex,
      lark,
      config: cardModeConfig({ iconImageKey: "img_config_logo" }),
      assetImageKeys: {}
    });

    manager.submitIncoming(message("m1", "first"));

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalled());
    const card = vi.mocked(lark.replyCard).mock.calls[0]![1] as { header?: Record<string, unknown> };
    expect(card.header).not.toHaveProperty("icon");
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

  it("shows imageGeneration placeholders and appends generated images to final cards", async () => {
    const generatedPath = path.join(os.tmpdir(), "twinny-generated-image.png");
    const generatedImage = {
      id: "ig_1",
      status: "completed",
      savedPath: generatedPath
    };
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onImageGeneration }) => {
        await onTurnStarted?.("turn_1");
        await onImageGeneration?.(generatedImage);
        return {
          threadId,
          turnId: "turn_1",
          text: "",
          status: "completed" as const,
          generatedImages: [generatedImage]
        };
      })
    });
    const lark = createLarkResponder();
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(),
      uploadImage: vi.fn(async () => ({ imageKey: "img_generated" }))
    };
    const manager = createManager({ codex, lark, larkFiles, config: cardModeConfig() });

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

    expect(larkFiles.uploadImage).toHaveBeenCalledWith({
      filePath: generatedPath,
      fileName: "twinny-generated-image.png",
      contentType: "image/png"
    });
    expect(JSON.stringify(vi.mocked(lark.patchCard).mock.calls)).toContain(`[已生成图片] ${generatedPath}`);
    const finalCard = vi.mocked(lark.replyCard).mock.calls.at(-1)![1] as Record<string, unknown>;
    const serialized = JSON.stringify(finalCard);
    expect(serialized).toContain(`[已生成图片] ${generatedPath}`);
    expect(serialized).toContain("img_generated");
  });

  it("does not auto-append generated images when the final card output has SEND_TO_LARK directives", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-card-generated-image-"));
    const workspaceRoot = path.join(tempRoot, "workspaces");
    const workspace = path.join(workspaceRoot, "p2p_ou_guest");
    fs.mkdirSync(workspace, { recursive: true });
    const explicitPath = path.join(workspace, "explicit.png");
    fs.writeFileSync(explicitPath, "png");
    const generatedPath = path.join(os.tmpdir(), "twinny-generated-skipped.png");
    const generatedImage = {
      id: "ig_1",
      status: "completed",
      savedPath: generatedPath
    };
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onImageGeneration, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onImageGeneration?.(generatedImage);
        await onAgentMessage?.({
          id: "agent_1",
          phase: "final_answer",
          text: `SEND_TO_LARK: <img path="${explicitPath}"></img>`
        });
        return {
          threadId,
          turnId: "turn_1",
          text: `SEND_TO_LARK: <img path="${explicitPath}"></img>`,
          status: "completed" as const,
          generatedImages: [generatedImage]
        };
      })
    });
    const lark = createLarkResponder();
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(),
      uploadImage: vi.fn(async ({ filePath }) => ({
        imageKey: filePath === explicitPath ? "img_explicit" : "img_generated"
      }))
    };
    const manager = createManager({ codex, lark, larkFiles, workspaceRoot, config: cardModeConfig() });

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

    expect(larkFiles.uploadImage).toHaveBeenCalledTimes(1);
    expect(larkFiles.uploadImage).toHaveBeenCalledWith({
      filePath: explicitPath,
      fileName: "explicit.png",
      contentType: "image/png"
    });
    const finalCard = vi.mocked(lark.replyCard).mock.calls.at(-1)![1] as Record<string, unknown>;
    const serialized = JSON.stringify(finalCard);
    expect(serialized).toContain("img_explicit");
    expect(serialized).not.toContain("img_generated");
  });

  it("renders Codex Lark mention tags only from the final card output", async () => {
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({
          id: "agent_1",
          text: "checking <mention-lark-user>ou_noise</mention-lark-user>",
          phase: "commentary"
        });
        await onAgentMessage?.({
          id: "agent_2",
          text: "请看 <mention-lark-user>ou_target</mention-lark-user>",
          phase: "final_answer"
        });
        return {
          threadId,
          turnId: "turn_1",
          text: "checking <mention-lark-user>ou_noise</mention-lark-user>\n\n请看 <mention-lark-user>ou_target</mention-lark-user>",
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
    const serialized = JSON.stringify(finalCard);
    expect(serialized).toContain("<at id=ou_target></at>");
    expect(serialized).not.toContain("<at id=ou_noise></at>");
    expect(serialized).not.toContain("<mention-lark-user>ou_target</mention-lark-user>");
    expect(finalCard.config).toMatchObject({
      summary: { content: "请看 @ou_target" }
    });
  });

  it("renders Codex Lark mention tags only from fallback plain final_answer messages", async () => {
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({
          id: "agent_1",
          text: "checking <mention-lark-user>ou_noise</mention-lark-user>",
          phase: "commentary"
        });
        await onAgentMessage?.({
          id: "agent_2",
          text: "hi <mention-lark-user>ou_target</mention-lark-user> please",
          phase: "final_answer"
        });
        return completed(threadId, "turn_1");
      })
    });
    const lark = createLarkResponder();
    vi.mocked(lark.replyCard).mockRejectedValue(new Error("card unavailable"));
    const manager = createManager({ codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyPost).toHaveBeenCalledTimes(1));

    expect(lark.replyMarkdown).toHaveBeenCalledWith(
      "m1",
      "checking <mention-lark-user>ou_noise</mention-lark-user>"
    );
    expect(lark.replyPost).toHaveBeenCalledWith("m1", [
      [
        { tag: "md", text: "hi " },
        { tag: "at", user_id: "ou_target" },
        { tag: "md", text: " please" }
      ]
    ]);
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
    await waitForExpect(() => expect(manager.queueDepth("group_oc_group")).toBe(1));
    manager.submitIncoming(groupMessage("m3", "/steer", { senderOpenId: "ou_first", senderName: "First User" }));
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

  it("drops unauthorized control commands and invalid card actions without history", async () => {
    const { repository } = createRepository(groupConversationRecord());
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(groupMessage("g1", "active", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await turns[0]!.params.onAgentMessage?.({ id: "agent_1", text: "working" });
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    vi.mocked(lark.patchCard).mockClear();

    manager.submitIncoming(groupMessage("g2", "/next", { senderOpenId: "ou_other" }));
    manager.submitCardAction({
      eventId: "event_card_other",
      operatorOpenId: "ou_other",
      openMessageId: "card_g1_1",
      openChatId: "oc_group",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "queue",
        stateKey: "group_oc_group",
        runId: 1
      },
      raw: { event_id: "event_card_other" }
    });
    manager.submitCardAction({
      eventId: "event_card_stale",
      operatorOpenId: "ou_owner",
      openMessageId: "card_g1_1",
      openChatId: "oc_group",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "queue",
        stateKey: "group_oc_group",
        runId: 99
      },
      raw: { event_id: "event_card_stale" }
    });
    manager.submitCardAction({
      eventId: "event_card_owner",
      operatorOpenId: "ou_owner",
      openMessageId: "card_g1_1",
      openChatId: "oc_group",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "queue",
        stateKey: "group_oc_group",
        runId: 1
      },
      raw: { event_id: "event_card_owner" }
    });

    await waitForExpect(() => {
      const inserted = vi.mocked(repository.insertLarkMessage).mock.calls.map(([input]) => input);
      expect(inserted.some((input) => input.eventId === "event_card_owner" && input.routeKind === "card_action")).toBe(true);
    });
    const inserted = vi.mocked(repository.insertLarkMessage).mock.calls.map(([input]) => input);
    expect(inserted.some((input) => input.eventId === "e_g2")).toBe(false);
    expect(inserted.some((input) => input.eventId === "event_card_other")).toBe(false);
    expect(inserted.some((input) => input.eventId === "event_card_stale")).toBe(false);
    expect(codex.interruptTurn).not.toHaveBeenCalled();
    expect(lark.patchCard).toHaveBeenCalled();

    turns[0]!.resolve(completed("thread_group", "turn_1"));
  });

  it("renders requestUserInput waiting card and submits form answers back to Codex", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    vi.mocked(lark.getMessageReadOpenIds).mockResolvedValue([]);
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });
    const responder = {
      respond: vi.fn(),
      reject: vi.fn()
    };

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await turns[0]!.params.onRequestUserInput?.(
      {
        requestId: "request_1",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          questions: [
            {
              id: "choice",
              header: "Choose mode",
              question: "Choose mode",
              isOther: true,
              isSecret: false,
              options: [{ label: "直接实现", description: "按计划改代码并测试。" }]
            }
          ]
        }
      },
      responder
    );

    await waitForExpect(() => {
      const card = vi.mocked(lark.patchCard).mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
      expect(card).toBeDefined();
      expect(JSON.stringify(card)).toContain("等待交互");
      expect(JSON.stringify(card)).toContain("Choose mode");
    });
    expect(repository.updateCodexThreadStatus).toHaveBeenCalledWith("p2p_ou_guest", "thread_1", "waiting");

    vi.mocked(lark.patchCard).mockClear();
    await turns[0]!.params.onAgentMessage?.({ id: "agent_after_wait", text: "late update" });
    await waitForExpect(() => {
      const card = vi.mocked(lark.patchCard).mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
      expect(card).toBeDefined();
      const serialized = JSON.stringify(card);
      expect(serialized).toContain("等待交互");
      expect(serialized).toContain("Choose mode");
      expect(serialized).not.toContain("工作中...");
    });

    manager.submitCardAction({
      eventId: "event_request_submit",
      operatorOpenId: "ou_guest",
      openMessageId: "card_m1_1",
      openChatId: "oc_ignored",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "request_input_submit",
        stateKey: "p2p_ou_guest",
        runId: 1
      },
      formValue: {},
      raw: { event_id: "event_request_submit" }
    });

    await waitForExpect(() => {
      const card = vi.mocked(lark.patchCard).mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
      expect(card).toBeDefined();
      const serialized = JSON.stringify(card);
      expect(serialized).toContain("工作中...");
      expect(serialized).toContain("[收到答案] Choose mode: 直接实现");
      expect(serialized).not.toContain("等待交互");
    });
    await waitForExpect(() =>
      expect(responder.respond).toHaveBeenCalledWith({
        answers: {
          choice: {
            answers: ["直接实现"]
          }
        }
      })
    );
    expect(repository.updateCodexThreadStatus).toHaveBeenCalledWith("p2p_ou_guest", "thread_1", "working");

    turns[0]!.resolve(completed("thread_1", "turn_1"));
  });

  it("skips requestUserInput questions by returning skip answers to Codex", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    vi.mocked(lark.getMessageReadOpenIds).mockResolvedValue([]);
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });
    const responder = {
      respond: vi.fn(),
      reject: vi.fn()
    };

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await turns[0]!.params.onRequestUserInput?.(
      {
        requestId: "request_1",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          questions: [
            {
              id: "choice",
              header: "Choose mode",
              question: "Choose mode",
              isOther: true,
              isSecret: false,
              options: [{ label: "直接实现", description: "按计划改代码并测试。" }]
            },
            {
              id: "details",
              header: "Details",
              question: "Any constraints?",
              isOther: true,
              isSecret: false,
              options: null
            }
          ]
        }
      },
      responder
    );

    await waitForExpect(() => {
      const card = vi.mocked(lark.patchCard).mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
      expect(card).toBeDefined();
      const serialized = JSON.stringify(card);
      expect(serialized).toContain("等待交互");
      expect(serialized).toContain("跳过");
    });

    vi.mocked(lark.patchCard).mockClear();
    manager.submitCardAction({
      eventId: "event_request_skip",
      operatorOpenId: "ou_guest",
      openMessageId: "card_m1_1",
      openChatId: "oc_ignored",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "request_input_interrupt",
        stateKey: "p2p_ou_guest",
        runId: 1
      },
      raw: { event_id: "event_request_skip" }
    });

    await waitForExpect(() =>
      expect(responder.respond).toHaveBeenCalledWith({
        answers: {
          choice: {
            answers: ["user skip the question"]
          },
          details: {
            answers: ["user skip the question"]
          }
        }
      })
    );
    expect(codex.interruptTurn).not.toHaveBeenCalled();
    expect(repository.updateCodexThreadStatus).toHaveBeenCalledWith("p2p_ou_guest", "thread_1", "working");
    await waitForExpect(() => {
      const card = vi.mocked(lark.patchCard).mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
      expect(card).toBeDefined();
      const serialized = JSON.stringify(card);
      expect(serialized).toContain("工作中...");
      expect(serialized).toContain("[收到答案] Choose mode: user skip the question; Details: user skip the question");
      expect(serialized).not.toContain("等待交互");
    });
    await waitForExpect(() => {
      const cardActionInput = vi
        .mocked(repository.insertLarkMessage)
        .mock.calls.map(([input]) => input)
        .find((input) => input.eventId === "event_request_skip");
      expect(cardActionInput).toMatchObject({
        routeKind: "card_action",
        status: "completed",
        text: "/request-input skip"
      });
    });

    turns[0]!.resolve(completed("thread_1", "turn_1"));
  });

  it("queues requestUserInput follow-up messages behind an immediate same-user head", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    vi.mocked(lark.getMessageReadOpenIds).mockResolvedValue([]);
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });
    const responder = {
      respond: vi.fn(),
      reject: vi.fn()
    };

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await turns[0]!.params.onRequestUserInput?.(
      {
        requestId: "request_1",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          questions: [
            {
              id: "choice",
              header: "Choose mode",
              question: "Choose mode",
              isOther: true,
              isSecret: false,
              options: [{ label: "直接实现", description: "按计划改代码并测试。" }]
            }
          ]
        }
      },
      responder
    );
    await waitForExpect(() => {
      const card = vi.mocked(lark.patchCard).mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
      expect(card).toBeDefined();
      expect(JSON.stringify(card)).toContain("等待交互");
    });

    manager.submitIncoming(message("m2", "/queue queued follow-up"));
    manager.submitIncoming(message("m3", "second follow-up"));

    await waitForExpect(() =>
      expect(codex.interruptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "guest", threadId: "thread_1", turnId: "turn_1" })
      )
    );
    await waitForExpect(() => {
      const inserted = vi.mocked(repository.insertLarkMessage).mock.calls.map(([input]) => input);
      expect(inserted.find((input) => input.larkMessageId === "m2")).toMatchObject({
        routeKind: "message",
        status: "processing",
        text: "queued follow-up"
      });
      expect(inserted.find((input) => input.larkMessageId === "m3")).toMatchObject({
        routeKind: "queued_message",
        status: "queued",
        text: "second follow-up"
      });
    });
    expect(lark.addQueuedReaction).toHaveBeenCalledWith("m2");
    expect(lark.addQueuedReaction).toHaveBeenCalledWith("m3");
    expect(manager.queueDepth("p2p_ou_guest")).toBe(2);
    expect(codex.startTurn).toHaveBeenCalledTimes(1);

    turns[0]!.resolve(completed("thread_1", "turn_1", "interrupted"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(turns[1]!.params.input).toBe(
      `${wrappedMessage("queued follow-up", "m2")}\n${wrappedMessage("second follow-up", "m3")}`
    );
    expect(manager.queueDepth("p2p_ou_guest")).toBe(0);

    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("starts plan follow-up messages directly without queued reactions", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    vi.mocked(lark.getMessageReadOpenIds).mockResolvedValue([]);
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "draft a plan"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await turns[0]!.params.onPlanUpdated?.({
      threadId: "thread_1",
      turnId: "turn_1",
      explanation: "Plan ready",
      plan: [{ step: "Update the implementation", status: "pending" }]
    });
    await waitForExpect(() => {
      const card = vi.mocked(lark.patchCard).mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
      expect(card).toBeDefined();
      expect(JSON.stringify(card)).toContain("确认计划");
    });

    manager.submitIncoming(message("m2", "revise the plan"));

    await waitForExpect(() =>
      expect(codex.interruptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "guest", threadId: "thread_1", turnId: "turn_1" })
      )
    );
    await waitForExpect(() => {
      const inserted = vi.mocked(repository.insertLarkMessage).mock.calls.map(([input]) => input);
      expect(inserted.find((input) => input.larkMessageId === "m2")).toMatchObject({
        routeKind: "message",
        status: "processing",
        text: "revise the plan"
      });
    });
    expect(lark.addQueuedReaction).not.toHaveBeenCalled();
    expect(manager.queueDepth("p2p_ou_guest")).toBe(0);
    expect(codex.startTurn).toHaveBeenCalledTimes(1);

    turns[0]!.resolve(completed("thread_1", "turn_1", "interrupted"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(turns[1]!.params.input).toBe(wrappedMessage("revise the plan", "m2"));

    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("consumes only the same-user queue head from plan waiting, then transfers ownership after normal completion", async () => {
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository: createRepository(groupConversationRecord()).repository, codex });

    manager.submitIncoming(groupMessage("g1", "draft a plan", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(groupMessage("g2", "/queue same-user follow-up", { senderOpenId: "ou_guest" }));
    manager.submitIncoming(groupMessage("g3", "different-user follow-up", { senderOpenId: "ou_other" }));
    await waitForExpect(() => expect(manager.queueDepth("group_oc_group")).toBe(2));

    await turns[0]!.params.onPlanUpdated?.({
      threadId: "thread_group",
      turnId: "turn_1",
      explanation: "Plan ready",
      plan: [{ step: "Update the implementation", status: "pending" }]
    });
    await waitForExpect(() =>
      expect(codex.interruptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "guest", threadId: "thread_group", turnId: "turn_1" })
      )
    );

    turns[0]!.resolve(completed("thread_group", "turn_1", "interrupted"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(turns[1]!.params.input).toBe(wrappedMessage("same-user follow-up", "g2", "ou_guest"));
    expect(manager.queueDepth("group_oc_group")).toBe(1);

    turns[1]!.resolve(completed("thread_group", "turn_2"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(3));
    expect(turns[2]!.params.input).toBe(wrappedMessage("different-user follow-up", "g3", "ou_other"));

    turns[2]!.resolve(completed("thread_group", "turn_3"));
  });

  it("consumes a same-user /exit queued while plan waiting", async () => {
    const { repository } = createRepository(groupConversationRecord());
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g1", "draft a plan", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    await turns[0]!.params.onPlanUpdated?.({
      threadId: "thread_group",
      turnId: "turn_1",
      explanation: "Plan ready",
      plan: [{ step: "Update the implementation", status: "pending" }]
    });
    manager.submitIncoming(groupMessage("g2", "/exit", { senderOpenId: "ou_guest" }));

    await waitForExpect(() =>
      expect(codex.interruptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "guest", threadId: "thread_group", turnId: "turn_1" })
      )
    );

    turns[0]!.resolve(completed("thread_group", "turn_1", "interrupted"));
    await waitForExpect(() =>
      expect(repository.updateCodexThreadMode).toHaveBeenCalledWith("group_oc_group", "thread_group", "default")
    );
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g2"]);
    expect(lark.replyText).toHaveBeenCalledWith("g2", "已退出 plan mode。");
    expect(codex.startTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps a different-user queued message when the same-user waiting follow-up also ends waiting", async () => {
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository: createRepository(groupConversationRecord()).repository, codex });

    manager.submitIncoming(groupMessage("g1", "draft a plan", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(groupMessage("g2", "/queue same-user follow-up", { senderOpenId: "ou_guest" }));
    manager.submitIncoming(groupMessage("g3", "different-user follow-up", { senderOpenId: "ou_other" }));
    await waitForExpect(() => expect(manager.queueDepth("group_oc_group")).toBe(2));

    await turns[0]!.params.onPlanUpdated?.({
      threadId: "thread_group",
      turnId: "turn_1",
      explanation: "Plan ready",
      plan: [{ step: "Update the implementation", status: "pending" }]
    });
    turns[0]!.resolve(completed("thread_group", "turn_1", "interrupted"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));

    await turns[1]!.params.onPlanUpdated?.({
      threadId: "thread_group",
      turnId: "turn_2",
      explanation: "Follow-up plan ready",
      plan: [{ step: "Keep waiting", status: "pending" }]
    });
    turns[1]!.resolve(completed("thread_group", "turn_2"));

    await waitForDelay();
    expect(codex.startTurn).toHaveBeenCalledTimes(2);
    expect(manager.queueDepth("group_oc_group")).toBe(1);
  });

  it("reruns the waiting queue-head check after recall exposes a same-user message", async () => {
    const { repository } = createRepository(groupConversationRecord());
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository, codex });

    manager.submitIncoming(groupMessage("g1", "draft a plan", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(groupMessage("g2", "different-user queued", { senderOpenId: "ou_other" }));
    await waitForExpect(() => expect(manager.queueDepth("group_oc_group")).toBe(1));

    await turns[0]!.params.onPlanUpdated?.({
      threadId: "thread_group",
      turnId: "turn_1",
      explanation: "Plan ready",
      plan: [{ step: "Update the implementation", status: "pending" }]
    });
    await waitForDelay();
    expect(codex.interruptTurn).not.toHaveBeenCalled();
    expect(codex.startTurn).toHaveBeenCalledTimes(1);

    manager.submitIncoming(groupMessage("g3", "same-user queued while waiting", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(manager.queueDepth("group_oc_group")).toBe(2));
    expect(codex.interruptTurn).not.toHaveBeenCalled();

    manager.submitMessageRecall({ eventId: "recall_g2", messageId: "g2", raw: {} });
    await waitForExpect(() =>
      expect(codex.interruptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ role: "guest", threadId: "thread_group", turnId: "turn_1" })
      )
    );
    expect(repository.markLarkMessageRecalled).toHaveBeenCalledWith("g2");

    turns[0]!.resolve(completed("thread_group", "turn_1", "interrupted"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(turns[1]!.params.input).toBe(wrappedMessage("same-user queued while waiting", "g3", "ou_guest"));

    turns[1]!.resolve(completed("thread_group", "turn_2"));
  });

  it("starts confirmed plan implementation with the concise Codex prompt", async () => {
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    vi.mocked(lark.getMessageReadOpenIds).mockResolvedValue([]);
    const manager = createManager({ codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "draft a plan"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await turns[0]!.params.onPlanUpdated?.({
      threadId: "thread_1",
      turnId: "turn_1",
      explanation: "Plan ready",
      plan: [{ step: "Update the implementation", status: "pending" }]
    });

    await waitForExpect(() => {
      const card = vi.mocked(lark.patchCard).mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
      expect(card).toBeDefined();
      expect(JSON.stringify(card)).toContain("确认计划");
      expect(JSON.stringify(card)).toContain("实现");
    });

    manager.submitCardAction({
      eventId: "event_plan_implement",
      operatorOpenId: "ou_guest",
      openMessageId: "card_m1_1",
      openChatId: "oc_ignored",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "plan_implement",
        stateKey: "p2p_ou_guest",
        runId: 1
      },
      raw: { event_id: "event_plan_implement" }
    });

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(turns[1]!.params.input).toBe("Implement this plan");
    expect(turns[1]!.params.mode).toBe("default");
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(2));
    const implementationCard = vi.mocked(lark.replyCard).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(JSON.stringify(implementationCard)).toContain("- [已确认方案]");

    turns[0]!.resolve(completed("thread_1", "turn_1", "interrupted"));
    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("includes supplemental plan instruction in the default-mode implementation prompt", async () => {
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    vi.mocked(lark.getMessageReadOpenIds).mockResolvedValue([]);
    const manager = createManager({ codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "draft a plan"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await turns[0]!.params.onPlanUpdated?.({
      threadId: "thread_1",
      turnId: "turn_1",
      explanation: "Plan ready",
      plan: [{ step: "Update the implementation", status: "pending" }]
    });

    manager.submitCardAction({
      eventId: "event_plan_implement_with_instruction",
      operatorOpenId: "ou_guest",
      openMessageId: "card_m1_1",
      openChatId: "oc_ignored",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "plan_implement",
        stateKey: "p2p_ou_guest",
        runId: 1
      },
      formValue: {
        plan_implement_instruction: " keep API stable "
      },
      raw: { event_id: "event_plan_implement_with_instruction" }
    });

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(turns[1]!.params.input).toBe("Implement the plan with following instruction: keep API stable");
    expect(turns[1]!.params.mode).toBe("default");
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(2));
    const implementationCard = vi.mocked(lark.replyCard).mock.calls.at(-1)![1] as Record<string, unknown>;
    const implementationSerialized = JSON.stringify(implementationCard);
    expect(implementationSerialized).toContain("- [已确认方案] keep API stable");
    expect(implementationSerialized.indexOf("[已确认方案]")).toBeLessThan(implementationSerialized.indexOf("已工作"));

    turns[0]!.resolve(completed("thread_1", "turn_1", "interrupted"));
    turns[1]!.resolve(completed("thread_1", "turn_2"));
  });

  it("uploads SEND_TO_LARK image directives through fallback plain replies", async () => {
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
    vi.mocked(lark.replyCard).mockRejectedValue(new Error("card unavailable"));
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

  it("uploads SEND_TO_LARK files through fallback plain replies", async () => {
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
    vi.mocked(lark.replyCard).mockRejectedValue(new Error("card unavailable"));
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

  it("rejects SEND_TO_LARK symlinks through fallback plain replies", async () => {
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
    vi.mocked(lark.replyCard).mockRejectedValue(new Error("card unavailable"));
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

  it("recovers processing messages with active persisted goal state by resuming the goal", async () => {
    const row = conversationRecord({ codexThreadId: "thread_recovered" });
    const record = larkMessageRecord({
      larkMessageId: "m_goal",
      eventId: "e_m_goal",
      codexThreadId: "thread_recovered",
      routeKind: "goal_message",
      status: "processing",
      text: "finish recovered goal",
      rawEventJson: JSON.stringify(rawReceiveEvent("m_goal", "/goal finish recovered goal"))
    });
    const { repository } = createRepository(row, {
      larkMessages: [record],
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_recovered",
          conversationKey: "p2p_ou_guest",
          role: "guest",
          goalStatus: "active",
          goalUpdatedAt: 1000
        })
      ]
    });
    const codex = createCodex({
      resumeGoal: vi.fn(async () => {
        throw new Error("Goal missed after relaunching");
      })
    });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    await manager.recoverUnfinishedMessages();

    await waitForExpect(() => expect(codex.getThreadGoal).toHaveBeenCalledWith({
      role: "guest",
      threadId: "thread_recovered"
    }));
    expect(repository.updateCodexThreadGoalStatus).toHaveBeenCalledWith({
      codexThreadId: "thread_recovered",
      goalStatus: "active",
      goalUpdatedAt: 1
    });
    await waitForExpect(() => expect(codex.resumeGoal).toHaveBeenCalledTimes(1));
    expect(codex.resumeGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "guest",
        threadId: "thread_recovered",
        cwd: "/tmp/twinny/workspaces/p2p_ou_guest"
      })
    );
    expect(codex.startTurn).not.toHaveBeenCalled();
    await waitForExpect(() => expect(repository.markLarkMessagesFailed).toHaveBeenCalledWith(["m_goal"]));
    await waitForExpect(() => expect(JSON.stringify(vi.mocked(lark.patchCard).mock.calls)).toContain("Goal missed after relaunching"));
    expect(lark.replyText).not.toHaveBeenCalledWith("m_goal", "处理失败：Goal missed after relaunching");
  });

  it("does not use route_kind=goal_message alone to recover a goal", async () => {
    const row = conversationRecord({ codexThreadId: "thread_recovered" });
    const record = larkMessageRecord({
      larkMessageId: "m_goal_without_status",
      eventId: "e_m_goal_without_status",
      codexThreadId: "thread_recovered",
      routeKind: "goal_message",
      status: "processing",
      text: "finish recovered goal",
      rawEventJson: JSON.stringify(rawReceiveEvent("m_goal_without_status", "/goal finish recovered goal"))
    });
    const { repository } = createRepository(row, { larkMessages: [record] });
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    await manager.recoverUnfinishedMessages();
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    expect(codex.getThreadGoal).not.toHaveBeenCalled();
    expect(codex.resumeGoal).not.toHaveBeenCalled();
    expect(codex.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread_recovered",
      input: "Twinny daemon has beed reloaded, continue with the unfinished work."
    }));
  });

  it("recovers only unfinished messages for the selected role", async () => {
    const guestRecord = larkMessageRecord({
      larkMessageId: "m_guest",
      larkUserId: "ou_guest",
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_guest",
      rawEventJson: JSON.stringify(rawReceiveEvent("m_guest", "guest message"))
    });
    const ownerRecord = larkMessageRecord({
      larkMessageId: "m_owner",
      larkUserId: "ou_owner",
      conversationKey: "p2p_ou_owner",
      codexThreadId: "thread_owner",
      rawEventJson: JSON.stringify({
        ...rawReceiveEvent("m_owner", "owner message"),
        sender: { sender_id: { open_id: "ou_owner" }, sender_type: "user" }
      })
    });
    const { repository } = createRepository(undefined, {
      larkMessages: [guestRecord, ownerRecord],
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_guest",
          conversationKey: "p2p_ou_guest",
          role: "guest"
        }),
        codexThreadRecord({
          id: 2,
          codexThreadId: "thread_owner",
          conversationKey: "p2p_ou_owner",
          role: "owner"
        })
      ]
    });
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    await manager.recoverUnfinishedMessages({ role: "owner" });
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    expect(codex.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ role: "owner", threadId: "thread_owner" }));
    expect(codex.resumeThread).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread_guest" }));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "owner",
        threadId: "thread_owner",
        input: "Twinny daemon has beed reloaded, continue with the unfinished work."
      })
    );
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

  it("recovers queued /compact by rerunning the compact control path", async () => {
    const row = conversationRecord({ codexThreadId: "thread_recovered" });
    const record = larkMessageRecord({
      larkMessageId: "m2",
      routeKind: "queued_message",
      status: "queued",
      text: "/compact",
      rawEventJson: JSON.stringify(rawReceiveEvent("m2", "/compact"))
    });
    const { repository } = createRepository(row, { larkMessages: [record] });
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    await manager.recoverUnfinishedMessages();
    await waitForExpect(() => expect(codex.compactThread).toHaveBeenCalledTimes(1));

    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(codex.compactThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_recovered",
        role: "guest"
      })
    );
  });

  it("recovers processing /compact by rerunning compact instead of the recovery prompt", async () => {
    const row = conversationRecord({ codexThreadId: "thread_recovered" });
    const record = larkMessageRecord({
      larkMessageId: "m2",
      routeKind: "queued_message",
      status: "processing",
      text: "/compact",
      codexThreadId: "thread_recovered",
      rawEventJson: JSON.stringify(rawReceiveEvent("m2", "/compact"))
    });
    const { repository } = createRepository(row, { larkMessages: [record] });
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    await manager.recoverUnfinishedMessages();
    await waitForExpect(() => expect(codex.compactThread).toHaveBeenCalledTimes(1));

    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(codex.compactThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_recovered",
        role: "guest"
      })
    );
  });

  it("recovers processing thread replies from persisted DB fields when raw event JSON is missing", async () => {
    const row = groupConversationRecord({ role: "owner", codexThreadId: "thread_recovered" });
    const record = larkMessageRecord({
      larkMessageId: "m_thread_reply",
      eventId: "thread_reply:e_original",
      larkUserId: "ou_owner",
      larkGroupId: "oc_group",
      larkThreadId: "omt_recovered",
      conversationKey: "group_oc_group",
      codexThreadId: "thread_recovered",
      status: "processing",
      text: "recover from stored fields",
      rawEventJson: "{}"
    });
    const { repository } = createRepository(row, {
      larkMessages: [record],
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_recovered",
          conversationKey: "group_oc_group",
          larkThreadId: "omt_recovered",
          role: "owner"
        })
      ]
    });
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    await manager.recoverUnfinishedMessages();
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    expect(codex.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread_recovered" }));
    expect(repository.markLarkMessagesProcessing).toHaveBeenCalledWith(["m_thread_reply"], {
      conversationKey: "group_oc_group",
      codexThreadId: "thread_recovered"
    });
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
        input: [
          {
            type: "text",
            text:
              '<lark_message lark_message_id="m2" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\n' +
              '<img path="/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m2/img_1.png" lark_file_key="img_1" size="789">',
            text_elements: []
          },
          {
            type: "localImage",
            path: "/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/m2/img_1.png",
            detail: null
          },
          {
            type: "text",
            text: "</img>\n</lark_message>",
            text_elements: []
          }
        ]
      })
    );
  });

  it("fails processing side messages on startup recovery and patches the side card", async () => {
    const record = larkMessageRecord({
      larkMessageId: "m_side_recover",
      routeKind: "side_message",
      status: "processing",
      text: "stale side",
      codexThreadId: "thread_side_recover",
      codexTurnId: "turn_side_recover",
      sideId: 1,
      agentCardMessageId: "card_side_recover"
    });
    const { repository } = createRepository(conversationRecord(), { larkMessages: [record] });
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    await manager.recoverUnfinishedMessages();

    expect(repository.markLarkMessagesFailed).toHaveBeenCalledWith(["m_side_recover"]);
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(lark.patchCard).toHaveBeenCalledWith(
      "card_side_recover",
      expect.objectContaining({
        header: expect.objectContaining({
          template: "red",
          title: { tag: "plain_text", content: "发生错误" },
          subtitle: { tag: "plain_text", content: "临时会话" }
        })
      })
    );
    const failedCard = vi.mocked(lark.patchCard).mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(failedCard)).toContain("Twinny 服务退出");
  });

  it("fails running side turns during shutdown with the service-exit error", async () => {
    const { repository } = createRepository(conversationRecord());
    const { codex, turns } = createDeferredCodex();
    vi.mocked(codex.forkThread).mockResolvedValue({ threadId: "thread_1_side" });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m_side_shutdown", "/side inspect"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await manager.shutdown();

    expect(repository.markLarkMessagesFailed).toHaveBeenCalledWith(["m_side_shutdown"]);
    expect(codex.interruptTurn).toHaveBeenCalledWith(expect.objectContaining({
      role: "guest",
      threadId: "thread_1_side",
      turnId: "turn_1"
    }));
    expect(lark.patchCard).toHaveBeenCalledWith(
      "card_m_side_shutdown_1",
      expect.objectContaining({
        header: expect.objectContaining({
          template: "red",
          title: { tag: "plain_text", content: "发生错误" },
          subtitle: { tag: "plain_text", content: "临时会话" }
        })
      })
    );
    const failedCard = vi.mocked(lark.patchCard).mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(failedCard)).toContain("Twinny 服务退出");

    turns[0]!.resolve(completed("thread_1_side", "turn_1", "interrupted"));
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
            title: { tag: "plain_text", content: "工作中断" },
            subtitle: { tag: "plain_text", content: "服务重启中，任务将在重启后自动恢复" }
          })
        })
      )
    );
    const pausedCard = vi.mocked(lark.patchCard).mock.calls.at(-1)![1] as Record<string, unknown>;
    const serialized = JSON.stringify(pausedCard);
    expect(serialized).not.toContain("已暂停，服务重启后继续");
    expect(serialized).not.toContain("\"tag\":\"button\"");
    expect(serialized).not.toContain("停止");
    expect(serialized).not.toContain("打断并处理队列中消息");
    expect(repository.markLarkMessagesFailed).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesInterrupted).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCleared).not.toHaveBeenCalled();
  });

  it("suspends active turns for an exited app-server role without interrupting or failing messages", async () => {
    const { codex } = createDeferredCodex();
    const lark = createLarkResponder();
    const { repository } = createRepository();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await expect(manager.suspendActiveTurnsForCodexAppServerExit("owner")).resolves.toBe(0);
    await expect(manager.suspendActiveTurnsForCodexAppServerExit("guest")).resolves.toBe(1);

    expect(codex.interruptTurn).not.toHaveBeenCalled();
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
    expect(repository.markLarkMessagesFailed).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesInterrupted).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCleared).not.toHaveBeenCalled();
  });

  it("leaves turns recoverable when Codex protocol closes during an active turn", async () => {
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const { repository } = createRepository();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    turns[0]!.reject(new TwinnyError("Codex protocol connection closed", "CODEX_PROTOCOL_CLOSED"));

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
    expect(repository.markLarkMessagesFailed).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesInterrupted).not.toHaveBeenCalled();
    expect(lark.replyText).not.toHaveBeenCalledWith("m1", expect.stringContaining("Codex protocol connection closed"));
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
  assetImageKeys?: ConstructorParameters<typeof ConversationManager>[0]["assetImageKeys"];
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
    assetImageKeys: options.assetImageKeys,
    logger: options.logger,
    nameLookupFailureTtlMs: 60_000
  });
}

function cardModeConfig(overrides: Partial<TwinnyConfig["lark"]> = {}): TwinnyConfig {
  return {
    ...config,
    lark: {
      ...config.lark,
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
    forkThread: vi.fn(async ({ threadId }) => ({ threadId: `${threadId}_fork` })),
    injectThreadItems: vi.fn(async () => undefined),
    unsubscribeThread: vi.fn(async () => undefined),
    startTurn: vi.fn(async ({ threadId, onTurnStarted }) => {
      await onTurnStarted?.("turn_1");
      return completed(threadId, "turn_1");
    }),
    compactThread: vi.fn(async ({ threadId, onTurnStarted }) => {
      await onTurnStarted?.("compact_1");
      return completed(threadId, "compact_1");
    }),
    steerTurn: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
    setThreadGoal: vi.fn(async ({ threadId, objective }) => ({
      threadId,
      objective,
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1
    })),
    getThreadGoal: vi.fn(async ({ threadId }) => ({
      threadId,
      objective: "active goal",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1
    })),
    clearThreadGoal: vi.fn(async () => undefined),
    runGoal: vi.fn(async ({ threadId, objective, onTurnStarted }) => {
      await onTurnStarted?.("goal_1");
      return { ...completed(threadId, "goal_1"), text: objective };
    }),
    resumeGoal: vi.fn(async ({ threadId, onTurnStarted }) => {
      await onTurnStarted?.("goal_1");
      return completed(threadId, "goal_1");
    }),
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

function createDeferredCompactCodex(): {
  codex: CodexBridge;
  compacts: Array<Deferred<CodexTurnResult> & { params: Parameters<CodexBridge["compactThread"]>[0] }>;
} {
  const compacts: Array<Deferred<CodexTurnResult> & { params: Parameters<CodexBridge["compactThread"]>[0] }> = [];
  const codex = createCodex({
    compactThread: vi.fn((params) => {
      const compact = deferred<CodexTurnResult>();
      compacts.push({ ...compact, params });
      void params.onTurnStarted?.(`compact_${compacts.length}`);
      return compact.promise;
    })
  });
  return { codex, compacts };
}

function createDeferredGoalCodex(): {
  codex: CodexBridge;
  goals: Array<Deferred<CodexTurnResult> & { params: Parameters<NonNullable<CodexBridge["runGoal"]>>[0] }>;
} {
  const goals: Array<Deferred<CodexTurnResult> & { params: Parameters<NonNullable<CodexBridge["runGoal"]>>[0] }> = [];
  const codex = createCodex({
    runGoal: vi.fn((params) => {
      const goal = deferred<CodexTurnResult>();
      goals.push({ ...goal, params });
      void params.onTurnStarted?.(`goal_${goals.length}`);
      return goal.promise;
    })
  });
  return { codex, goals };
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
    replyImage: vi.fn(async (messageId) => ({ messageId: `reply_${messageId}_${++markdownReplyCount}` })),
    sendTextToOpenId: vi.fn(async () => undefined),
    sendCardToChatId: vi.fn(async (chatId) => ({ messageId: `card_${chatId}_${++markdownReplyCount}`, raw: {} })),
    sendEphemeralCardToChatId: vi.fn(async (chatId) => ({ messageId: `ephemeral_${chatId}_${++markdownReplyCount}`, raw: {} })),
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
    forkedFromCodexThreadId?: string;
    forkedAt?: number;
    name?: string;
  }): CodexThreadRecord => {
    const existing = codexThreads.get(input.codexThreadId);
    const record = codexThreadRecord({
      ...existing,
      id: existing?.id ?? nextCodexThreadId++,
      codexThreadId: input.codexThreadId,
      conversationKey: input.conversationKey,
      name: input.name ?? existing?.name ?? "新会话",
      larkThreadId: input.larkThreadId ?? existing?.larkThreadId,
      role: input.role,
      forkedFromCodexThreadId: input.forkedFromCodexThreadId ?? existing?.forkedFromCodexThreadId,
      forkedAt: input.forkedAt ?? existing?.forkedAt,
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
      name: existing?.name ?? "新会话",
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
          name: input.name ?? existing?.name ?? "新会话",
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
      updateCodexThreadName: vi.fn((codexThreadId, name) => {
        const existing = codexThreads.get(codexThreadId);
        if (!existing) {
          return undefined;
        }
        existing.name = name;
        existing.updatedAt = Date.now();
        return existing;
      }),
      updateCodexThreadMode: vi.fn((conversationKey, codexThreadId, mode) => {
        const existing = codexThreads.get(codexThreadId);
        if (!existing) {
          throw new Error("missing codex thread");
        }
        existing.conversationKey = conversationKey;
        existing.mode = mode;
        existing.updatedAt = Date.now();
        return existing;
      }),
      updateCodexThreadStatus: vi.fn((conversationKey, codexThreadId, status) => {
        const existing = codexThreads.get(codexThreadId);
        if (!existing) {
          throw new Error("missing codex thread");
        }
        existing.conversationKey = conversationKey;
        existing.status = status;
        existing.updatedAt = Date.now();
        return existing;
      }),
      updateCodexThreadGoalStatus: vi.fn((input) => {
        const existing = codexThreads.get(input.codexThreadId);
        if (!existing) {
          throw new Error("missing codex thread");
        }
        existing.goalStatus = input.goalStatus;
        existing.goalUpdatedAt = input.goalStatus === "none" ? undefined : input.goalUpdatedAt ?? Date.now();
        existing.updatedAt = Date.now();
        return existing;
      }),
      clearCodexThreadGoalStatus: vi.fn((codexThreadId) => {
        const existing = codexThreads.get(codexThreadId);
        if (!existing) {
          throw new Error("missing codex thread");
        }
        existing.goalStatus = "none";
        existing.goalUpdatedAt = undefined;
        existing.updatedAt = Date.now();
        return existing;
      }),
      getCodexThreadWorkStats: vi.fn((codexThreadId) => {
        const turns = new Map<string, { startedAt: number; terminalAt?: number }>();
        for (const message of larkMessages.values()) {
          if (message.routeKind === "side_message" || message.codexThreadId !== codexThreadId || !message.codexTurnId || !message.processingStartedAt) {
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
      getCodexThreadStatusStats: vi.fn((codexThreadId) => {
        const turns = new Map<string, { startedAt: number; terminalAt?: number }>();
        let userMessageCount = 0;
        for (const message of larkMessages.values()) {
          if (message.codexThreadId !== codexThreadId) {
            continue;
          }
          if (isUserMessageRouteKind(message.routeKind)) {
            userMessageCount += 1;
          }
          if (message.routeKind === "side_message" || !message.codexTurnId || !message.processingStartedAt) {
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
          userMessageCount,
          turnCount: turns.size,
          totalWorkDurationMs: [...turns.values()].reduce((sum, turn) =>
            sum + (turn.terminalAt && turn.terminalAt > turn.startedAt ? turn.terminalAt - turn.startedAt : 0), 0)
        };
      }),
      getConversationStatusStats: vi.fn((conversationKey) => {
        const threads = [...codexThreads.values()].filter((thread) => thread.conversationKey === conversationKey);
        const turns = new Map<string, { startedAt: number; terminalAt?: number }>();
        let userMessageCount = 0;
        for (const message of larkMessages.values()) {
          if (message.conversationKey !== conversationKey) {
            continue;
          }
          if (isUserMessageRouteKind(message.routeKind)) {
            userMessageCount += 1;
          }
          if (message.routeKind === "side_message" || !message.codexThreadId || !message.codexTurnId || !message.processingStartedAt) {
            continue;
          }
          const turnKey = `${message.codexThreadId}:${message.codexTurnId}`;
          const existing = turns.get(turnKey);
          const terminalAt = message.completedAt ?? message.failedAt ?? message.clearedAt;
          turns.set(turnKey, {
            startedAt: Math.min(existing?.startedAt ?? message.processingStartedAt, message.processingStartedAt),
            terminalAt: Math.max(existing?.terminalAt ?? 0, terminalAt ?? 0) || existing?.terminalAt
          });
        }
        return {
          topicCount: threads.length,
          userMessageCount,
          inputTokens: threads.reduce((sum, thread) => sum + thread.inputTokens, 0),
          outputTokens: threads.reduce((sum, thread) => sum + thread.outputTokens, 0),
          cachedInputTokens: threads.reduce((sum, thread) => sum + thread.cachedInputTokens, 0),
          reasoningOutputTokens: threads.reduce((sum, thread) => sum + thread.reasoningOutputTokens, 0),
          totalTokens: threads.reduce((sum, thread) => sum + thread.totalTokens, 0),
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
          sideId: input.sideId,
          agentCardMessageId: input.agentCardMessageId,
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
      updateLarkMessageSideMetadata: vi.fn((larkMessageId, update) => {
        const existing = larkMessages.get(larkMessageId);
        if (!existing) {
          return false;
        }
        existing.sideId = update.sideId ?? existing.sideId;
        existing.agentCardMessageId = update.agentCardMessageId ?? existing.agentCardMessageId;
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
      markLarkMessagesCompleted: vi.fn((messageIds) => {
        const now = Date.now();
        for (const messageId of messageIds) {
          const existing = larkMessages.get(messageId);
          if (existing) {
            existing.status = "completed";
            existing.completedAt = existing.completedAt ?? now;
            existing.updatedAt = now;
          }
        }
      }),
      markLarkMessagesFailed: vi.fn((messageIds) => {
        const now = Date.now();
        for (const messageId of messageIds) {
          const existing = larkMessages.get(messageId);
          if (existing) {
            existing.status = "failed";
            existing.failedAt = existing.failedAt ?? now;
            existing.updatedAt = now;
          }
        }
      }),
      markLarkMessagesInterrupted: vi.fn((messageIds) => {
        const now = Date.now();
        for (const messageId of messageIds) {
          const existing = larkMessages.get(messageId);
          if (existing) {
            existing.status = "interrupted";
            existing.failedAt = existing.failedAt ?? now;
            existing.updatedAt = now;
          }
        }
      }),
      markLarkMessagesCleared: vi.fn((messageIds) => {
        const now = Date.now();
        for (const messageId of messageIds) {
          const existing = larkMessages.get(messageId);
          if (existing) {
            existing.status = "cleared";
            existing.clearedAt = existing.clearedAt ?? now;
            existing.updatedAt = now;
          }
        }
      })
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

function isUserMessageRouteKind(routeKind: LarkMessageRecord["routeKind"]): boolean {
  return (
    routeKind === "message" ||
    routeKind === "goal_message" ||
    routeKind === "steered_message" ||
    routeKind === "queued_message" ||
    routeKind === "side_message"
  );
}

function codexThreadRecord(overrides: Partial<CodexThreadRecord> = {}): CodexThreadRecord {
  return {
    id: 1,
    codexThreadId: "thread_1",
    conversationKey: "p2p_ou_guest",
    name: "新会话",
    role: "guest",
    mode: "default",
    status: "idle",
    goalStatus: "none",
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
