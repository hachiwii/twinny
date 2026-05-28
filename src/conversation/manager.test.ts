import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { describe, expect, it, vi, type Mock } from "vitest";
import { TwinnyError } from "../errors.js";
import type { LarkFeatureCheckResult } from "../lark/feature-config.js";
import { LarkMessageUnavailableError } from "../lark/messages.js";
import type { TelemetryCaptureOptions, TelemetryClient, TelemetryErrorContext, TelemetryProperties } from "../telemetry/index.js";
import type {
  CodexThreadRecord,
  CodexTurnResult,
  ConversationRecord,
  IncomingLarkBotMenuAction,
  IncomingLarkDocCommentAdd,
  IncomingLarkMessage,
  LarkDocWatcherRecord,
  LarkMessageRecord,
  ProfileName,
  TwinnyConfig
} from "../types.js";
import {
  ConversationManager,
  type CodexBridge,
  type ConversationRepository,
  type LarkFileDownloader,
  type LarkDocCommentClient,
  type LarkDocCommentSnapshot,
  type LarkDocResolver,
  type LarkMessageReader,
  type LarkResponder,
  type LarkChatDirectory,
  type LarkUserDirectory,
  type LarkFeatureConfigurationStatusProvider
} from "./manager.js";

const config: TwinnyConfig = {
  home: "/tmp/twinny",
  codex: { binary: "codex" },
  lark: {
    workingReaction: "JubilantRabbit",
    completedReaction: "DONE",
    queuedReaction: "OneSecond",
    maxMessageAgeSeconds: 60,
    messageRedaction: {
      email: "mask",
      chinesePhoneNumber: "mask"
    }
  },
  auth: { larkAppId: "cli_xxx", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner" },
  homeIdentity: {
    random: "0123456789abcdef0123456789abcdef",
    telemetryHashSalt: "0123456789abcdef0123456789abcdef",
    keychainAccounts: {
      larkAppSecret: "twinny.home.0123456789abcdef0123456789abcdef.lark.app_secret"
    }
  },
  permissions: { p2pDefaultProfile: "guest" },
  service: { launchd: { mode: "gui" } },
  owner: { openId: "ou_owner", displayName: "Owner" },
  profiles: {
    host: { codexHome: "/tmp/twinny/profiles/host/codex", defaultModel: "gpt-5.5", defaultEffort: "medium" },
    guest: { codexHome: "/tmp/twinny/profiles/guest/codex", defaultModel: "gpt-5.5", defaultEffort: "medium" }
  }
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("ConversationManager", () => {
  it("emits message telemetry with internal route kinds and hashed insert ids", async () => {
    const { codex, turns } = createDeferredCodex();
    const telemetry = createTelemetry();
    const manager = createManager({ codex, telemetry });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "second"));

    await waitForExpect(() => {
      expect(capturedTelemetryEvents(telemetry, "twinny_message_received")).toHaveLength(2);
    });
    const events = capturedTelemetryEvents(telemetry, "twinny_message_received");

    expect(events.map((event) => event.properties.route_kind)).toEqual(["message", "steered_message"]);
    expect(events[0]!.properties).toMatchObject({
      conversation_id: "hashed:conversation:12",
      sender_id: "hashed:lark_open_id:8",
      message_event_id: "hashed:lark_event:4",
      message_id: "hashed:lark_message:2",
      message_type: "text",
      status_at_receive: "processing"
    });
    expect(events[0]!.options.insertId).toBe("twinny_message_received:hashed:lark_event:4");
    expect(JSON.stringify(events)).not.toContain("ou_guest");
    expect(JSON.stringify(events)).not.toContain("p2p_ou_guest");
    expect(JSON.stringify(events)).not.toContain("e_m1");
    expect(JSON.stringify(events)).not.toContain("m1");

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForDelay();
  });

  it("annotates message telemetry with command, menu, card, and queue context", async () => {
    const { codex, turns } = createDeferredCodex();
    const telemetry = createTelemetry();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, telemetry, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "active"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await turns[0]!.params.onAgentMessage?.({ id: "agent_1", text: "working" });
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    manager.submitIncoming(message("m_help", "/help"));
    manager.submitIncoming(message("m_queue", "/queue explicitly queued"));
    manager.submitBotMenuAction(botMenuAction("menu-status", "status"));
    manager.submitCardAction({
      eventId: "event_card_queue",
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
      raw: { event_id: "event_card_queue" }
    });
    await waitForExpect(() => expect(lark.patchCard).toHaveBeenCalled());
    manager.submitIncoming(message("m_queue_toggle", "queued by queue toggle"));

    await waitForExpect(() => {
      const events = capturedTelemetryEvents(telemetry, "twinny_message_received");
      expect(events.some((event) =>
        event.properties.route_kind === "control_message" &&
        event.properties.control_message_type === "help" &&
        event.properties.queue_reason === null
      )).toBe(true);
      expect(events.some((event) =>
        event.properties.route_kind === "queued_message" &&
        event.properties.control_message_type === "queue" &&
        event.properties.queue_reason === "explicit_queue_command"
      )).toBe(true);
      expect(events.some((event) =>
        event.properties.route_kind === "menu_action" &&
        event.properties.menu_button_type === "status" &&
        event.properties.action_type === "status"
      )).toBe(true);
      expect(events.some((event) =>
        event.properties.route_kind === "card_action" &&
        event.properties.card_action_type === "queue" &&
        event.properties.action_type === "queue"
      )).toBe(true);
      expect(events.some((event) =>
        event.properties.route_kind === "queued_message" &&
        event.properties.queue_reason === "queue_next_message" &&
        event.properties.control_message_type === null
      )).toBe(true);
    });

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    turns[1]!.resolve(completed("thread_1", "turn_2"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(3));
    turns[2]!.resolve(completed("thread_1", "turn_3"));
    await waitForDelay();
  });

  it("injects lark-cli profile guidance only when profile metadata exists", async () => {
    const withoutProfileCodex = createCodex();
    const withoutProfile = createManager({ codex: withoutProfileCodex });

    withoutProfile.submitIncoming(message("m_no_profile", "hello"));

    await waitForExpect(() => expect(withoutProfileCodex.startThread).toHaveBeenCalledTimes(1));
    expect(vi.mocked(withoutProfileCodex.startThread).mock.calls[0]![0].developerInstructions).not.toContain("--profile cli_xxx");

    const withProfileCodex = createCodex();
    const withProfile = createManager({
      codex: withProfileCodex,
      config: {
        ...config,
        larkCliProfile: { profileName: "cli_xxx" }
      }
    });

    withProfile.submitIncoming(message("m_with_profile", "hello"));

    await waitForExpect(() => expect(withProfileCodex.startThread).toHaveBeenCalledTimes(1));
    expect(vi.mocked(withProfileCodex.startThread).mock.calls[0]![0].developerInstructions).toContain(
      "pass `--profile cli_xxx`"
    );
  });

  it("emits turn-end telemetry with model, effort, token deltas, and message counts", async () => {
    const telemetry = createTelemetry();
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onTokenUsage }) => {
        await onTurnStarted?.("turn_1");
        await onTokenUsage?.({
          threadId,
          turnId: "turn_1",
          totalTokens: 16,
          raw: {
            threadId,
            turnId: "turn_1",
            usage: {
              total: {
                total_tokens: 16,
                input_tokens: 10,
                cached_input_tokens: 3,
                output_tokens: 4,
                reasoning_tokens: 2
              },
              last: { total_tokens: 96 },
              context_window: 128_000
            }
          }
        });
        return completed(threadId, "turn_1");
      })
    });
    const manager = createManager({ codex, telemetry });

    manager.submitIncoming(message("m1", "hello"));

    await waitForExpect(() => expect(capturedTelemetryEvents(telemetry, "twinny_turn_end")).toHaveLength(1));
    const event = capturedTelemetryEvents(telemetry, "twinny_turn_end")[0]!;
    expect(event.properties).toMatchObject({
      conversation_id: "hashed:conversation:12",
      thread_id: "hashed:codex_thread:8",
      turn_id: "hashed:codex_turn:6",
      status: "completed",
      turn_type: "default",
      turn_operation: "normal",
      message_count: 1,
      initial_message_count: 1,
      steer_message_count: 0,
      model: "gpt-5.5",
      effort: "medium",
      input_tokens: 10,
      output_tokens: 4,
      cached_input_tokens: 3,
      reasoning_tokens: 2,
      total_tokens: 16,
      context_tokens: 96,
      context_window: 128_000,
      error_type: null,
      error_code: null
    });
    expect(typeof event.properties.duration_ms).toBe("number");
    expect(event.options.insertId).toBe("twinny_turn_end:hashed:codex_turn_instance:15");
    expect(JSON.stringify(event)).not.toContain("thread_1");
    expect(JSON.stringify(event)).not.toContain("turn_1");
  });

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
    expect(repository.upsertCodexThread).toHaveBeenCalledWith(expect.objectContaining({
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_1",
      profile: "guest",
      name: "主会话",
      larkThreadId: undefined
    }));
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
      profile: "guest",
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
    expect(repository.updateLarkMessageTokenUsage).toHaveBeenCalledWith({
      larkMessageId: "m1",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      tokenUsageJson: JSON.stringify({
        threadId: "thread_1",
        turnId: "turn_1",
        usage: { total: { totalTokens: 42 } }
      })
    });
  });

  it("uses stored thread model settings when starting a turn", async () => {
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_1",
          conversationKey: "p2p_ou_guest",
          profile: "guest",
          model: "gpt-5.4",
          effort: "high"
        })
      ]
    });
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "hello"));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(turns[0]!.params).toMatchObject({
      threadId: "thread_1",
      model: "gpt-5.4",
      effort: "high"
    });

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForDelay();
  });

  it("backfills missing thread model settings from the profile defaults before starting a turn", async () => {
    const managerConfig: TwinnyConfig = {
      ...config,
      profiles: {
        ...config.profiles,
        guest: { ...config.profiles.guest, defaultModel: "gpt-5.4", defaultEffort: "xhigh" }
      }
    };
    const { repository } = createRepository(conversationRecord());
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository, codex, config: managerConfig });

    manager.submitIncoming(message("m1", "hello"));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(repository.updateCodexThreadModelSettings).toHaveBeenCalledWith({
      codexThreadId: "thread_1",
      model: "gpt-5.4",
      effort: "xhigh"
    });
    expect(turns[0]!.params).toMatchObject({
      model: "gpt-5.4",
      effort: "xhigh"
    });

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForDelay();
  });

  it("updates the current thread model settings with /model for later turns", async () => {
    const { repository } = createRepository(conversationRecord());
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m_model", "/model gpt-5.4 high"));

    await waitForExpect(() =>
      expect(repository.updateCodexThreadModelSettings).toHaveBeenCalledWith({
        codexThreadId: "thread_1",
        model: "gpt-5.4",
        effort: "high"
      })
    );
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(lark.replyText).toHaveBeenCalledWith(
      "m_model",
      "已设置当前 thread 后续 turn 模型：gpt-5.4 / high"
    );

    manager.submitIncoming(message("m1", "hello"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(turns[0]!.params).toMatchObject({
      model: "gpt-5.4",
      effort: "high"
    });

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForDelay();
  });

  it("lists cached workspaces and selects one with /workspace", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-manager-workspace-"));
    try {
      const firstWorkspace = path.join(tempDir, "first");
      const secondWorkspace = path.join(tempDir, "second");
      fs.mkdirSync(firstWorkspace);
      fs.mkdirSync(secondWorkspace);
      const store = createRepository(conversationRecord());
      const { repository } = store;
      vi.mocked(repository.listRecentThreadWorkspaces).mockReturnValue([firstWorkspace, secondWorkspace]);
      const codex = createCodex();
      const lark = createLarkResponder();
      const manager = createManager({ repository, codex, lark });

      manager.submitIncoming(message("m_workspace_list", "/workspace"));

      await waitForExpect(() =>
        expect(lark.replyMarkdown).toHaveBeenCalledWith(
          "m_workspace_list",
          [
            "当前 conversation workspace：`/tmp/twinny/workspaces/p2p_ou_guest`",
            "",
            `1. \`${firstWorkspace}\``,
            `2. \`${secondWorkspace}\``
          ].join("\n")
        )
      );
      expect(codex.startTurn).not.toHaveBeenCalled();

      manager.submitIncoming(message("m_workspace_select", "/workspace 2"));

      await waitForExpect(() =>
        expect(lark.replyText).toHaveBeenCalledWith(
          "m_workspace_select",
          [
            `已设置 conversation workspace：${secondWorkspace}`,
            "主会话 thread 已同步：thread_1"
          ].join("\n")
        )
      );
      expect(store.row?.workspace).toBe(secondWorkspace);
      expect(repository.getCodexThreadById("thread_1")).toMatchObject({ workspace: secondWorkspace });
      expect(codex.startTurn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects missing workspace directories", async () => {
    const missingWorkspace = path.join(os.tmpdir(), `twinny-missing-workspace-${Date.now()}`);
    fs.rmSync(missingWorkspace, { recursive: true, force: true });
    const { repository } = createRepository(conversationRecord());
    const lark = createLarkResponder();
    const manager = createManager({ repository, lark });

    manager.submitIncoming(message("m_workspace_missing", `/workspace ${missingWorkspace}`));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith(
        "m_workspace_missing",
        `workspace 路径不存在：${missingWorkspace}`
      )
    );
  });

  it("shares workspace selection lists between /workspace and /cd on the same thread", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-manager-cd-"));
    try {
      const topicWorkspace = path.join(tempDir, "topic");
      fs.mkdirSync(topicWorkspace);
      const conversation = groupConversationRecord();
      const { repository } = createRepository(conversation, {
        codexThreads: [
          codexThreadRecord({
            id: 20,
            codexThreadId: "thread_topic",
            conversationKey: "group_oc_group",
            larkThreadId: "topic_thread",
            workspace: "/tmp/twinny/workspaces/group_oc_group/topic",
            profile: "guest"
          })
        ]
      });
      vi.mocked(repository.listRecentThreadWorkspaces).mockReturnValue([topicWorkspace]);
      const codex = createCodex();
      const lark = createLarkResponder();
      const manager = createManager({ repository, codex, lark });
      const topicContext = {
        chatType: "topic_group" as const,
        larkThreadId: "topic_thread",
        larkRootMessageId: "topic_root"
      };

      manager.submitIncoming(groupMessage("m_topic_workspace_list", "/workspace", topicContext));

      await waitForExpect(() =>
        expect(lark.replyMarkdown).toHaveBeenCalledWith(
          "m_topic_workspace_list",
          [
            "当前 conversation workspace：`/tmp/twinny/workspaces/group_oc_group`",
            "",
            `1. \`${topicWorkspace}\``
          ].join("\n")
        )
      );

      manager.submitIncoming(groupMessage("m_topic_cd_list", "/cd", topicContext));

      await waitForExpect(() =>
        expect(lark.replyMarkdown).toHaveBeenCalledWith(
          "m_topic_cd_list",
          [
            "当前 thread workspace：`/tmp/twinny/workspaces/group_oc_group/topic`",
            "",
            `1. \`${topicWorkspace}\``
          ].join("\n")
        )
      );

      manager.submitIncoming(groupMessage("m_topic_cd_select", "/cd 1", topicContext));

      await waitForExpect(() =>
        expect(lark.replyText).toHaveBeenCalledWith(
          "m_topic_cd_select",
          `已设置当前 thread workspace：${topicWorkspace}`
        )
      );
      expect(repository.findByConversationKey("group_oc_group")).toMatchObject({
        workspace: conversation.workspace
      });
      expect(repository.getCodexThreadById("thread_group")).toMatchObject({
        workspace: conversation.workspace
      });
      expect(repository.getCodexThreadById("thread_topic")).toMatchObject({
        workspace: topicWorkspace
      });
      expect(codex.startTurn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects /cd on the main thread", async () => {
    const { repository } = createRepository(conversationRecord());
    const lark = createLarkResponder();
    const manager = createManager({ repository, lark });

    manager.submitIncoming(message("m_cd_main", "/cd"));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("m_cd_main", "主会话请使用 /workspace 设置 workspace。")
    );
    expect(repository.listRecentThreadWorkspaces).not.toHaveBeenCalled();
    expect(repository.updateCodexThreadWorkspace).not.toHaveBeenCalled();
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

    manager.submitCodexThreadNameUpdated({ threadId: "thread_named", name: "  [twinny] 新标题\n来自 Codex  " });

    await waitForExpect(() =>
      expect(repository.updateCodexThreadName).toHaveBeenCalledWith("thread_named", "新标题 来自 Codex")
    );
    await waitForExpect(() => expect(lark.patchCard).toHaveBeenCalledWith("card_thread_named", expect.any(Object)));
    const card = vi.mocked(lark.patchCard).mock.calls.find(([messageId]) => messageId === "card_thread_named")?.[1];
    expect(JSON.stringify(card)).toContain("新标题 来自 Codex");
  });

  it("ignores Codex thread name updates for the main session", async () => {
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
    const manager = createManager({ repository, lark });

    manager.submitCodexThreadNameUpdated({ threadId: "thread_1", name: "新标题" });
    await waitForDelay();

    expect(repository.updateCodexThreadName).not.toHaveBeenCalled();
    expect(lark.patchCard).not.toHaveBeenCalled();
  });

  it("does not pass the current thread name when starting a main-session Codex turn", async () => {
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
    const params = vi.mocked(codex.startTurn).mock.calls[0]![0];
    expect(params.input).toBe(wrappedMessage("hello", "m1"));
    expect(params.currentThreadName).toBeUndefined();
    expect(repository.getCodexThreadById("thread_1")).toMatchObject({ name: "主会话" });
  });

  it("syncs a prefixed Codex thread name when creating a main conversation", async () => {
    const { repository } = createRepository();
    const codex = createCodex({
      setThreadName: vi.fn(async () => undefined)
    });
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "hello", { senderName: "Guest User" }));

    await waitForExpect(() =>
      expect(codex.setThreadName).toHaveBeenCalledWith({
        profile: "guest",
        threadId: "thread_1",
        name: "[twinny] Guest User 主会话"
      })
    );
    await waitForExpect(() =>
      expect(repository.getCodexThreadById("thread_1")).toMatchObject({ name: "主会话" })
    );
  });

  it("syncs a prefixed Codex thread name when resuming a main conversation", async () => {
    const { repository } = createRepository(conversationRecord({ name: "Stored User" }), {
      mainThreadHasRollout: true
    });
    const codex = createCodex({
      setThreadName: vi.fn(async () => undefined),
      resumeThread: vi.fn(async ({ threadId }) => ({ threadId }))
    });
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "hello"));

    await waitForExpect(() =>
      expect(codex.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread_1" }))
    );
    await waitForExpect(() =>
      expect(codex.setThreadName).toHaveBeenCalledWith({
        profile: "guest",
        threadId: "thread_1",
        name: "[twinny] Stored User 主会话"
      })
    );
  });

  it("passes the current thread name when starting a branch Codex turn", async () => {
    const { repository } = createRepository(groupConversationRecord(), {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_topic",
          conversationKey: "group_oc_group",
          larkThreadId: "topic_1",
          name: "当前标题"
        })
      ]
    });
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    manager.submitIncoming(groupMessage("g1", "hello", { chatType: "topic_group", larkThreadId: "topic_1" }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_topic",
        input: wrappedMessage("hello", "g1"),
        currentThreadName: "当前标题"
      })
    );
  });

  it("handles set_thread_name tool calls for branch sessions by updating cards and syncing Codex thread name", async () => {
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
    const { repository } = createRepository(groupConversationRecord(), {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_topic",
          conversationKey: "group_oc_group",
          larkThreadId: "topic_1",
          name: "旧标题",
          cardMessageId: "card_thread_topic"
        })
      ]
    });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    try {
      manager.submitIncoming(groupMessage("g1", "hello", { chatType: "topic_group", larkThreadId: "topic_1" }));
      await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
      await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

      const response = await turnParams?.onSetThreadName?.({
        requestId: "req_1",
        threadId: "thread_topic",
        turnId: "turn_1",
        callId: "call_1",
        name: "  [twinny] 新标题\n来自工具  ",
        rawArguments: { name: "  [twinny] 新标题\n来自工具  " }
      });

      expect(response).toEqual({
        success: true,
        contentItems: [{ type: "inputText", text: "Thread name updated to: 新标题 来自工具" }]
      });
      expect(repository.updateCodexThreadName).toHaveBeenCalledWith("thread_topic", "新标题 来自工具");
      await waitForExpect(() =>
        expect(codex.setThreadName).toHaveBeenCalledWith({
          profile: "guest",
          threadId: "thread_topic",
          name: "[twinny] 新标题 来自工具"
        })
      );
      await waitForExpect(() =>
        expect(vi.mocked(lark.patchCard).mock.calls.some(([, card]) =>
          JSON.stringify(card).includes("[已更新标题] 新标题 来自工具")
        )).toBe(true)
      );
    } finally {
      turn.resolve(completed("thread_topic", "turn_1"));
      await turn.promise;
      await waitForDelay();
    }
  });

  it("ignores set_thread_name tool calls for the main session", async () => {
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
      vi.mocked(codex.setThreadName!).mockClear();

      const response = await turnParams?.onSetThreadName?.({
        requestId: "req_1",
        threadId: "thread_1",
        turnId: "turn_1",
        callId: "call_1",
        name: "新标题",
        rawArguments: { name: "新标题" }
      });

      expect(response).toEqual({
        success: true,
        contentItems: [{ type: "inputText", text: "Main session thread name is fixed to: 主会话" }]
      });
      expect(repository.updateCodexThreadName).not.toHaveBeenCalled();
      expect(codex.setThreadName).not.toHaveBeenCalled();
      expect(repository.getCodexThreadById("thread_1")).toMatchObject({ name: "主会话" });
    } finally {
      turn.resolve(completed("thread_1", "turn_1"));
      await turn.promise;
      await waitForDelay();
    }
  });

  it("lists Twinny-managed threads with category, Lark thread id, mode, and rollout metadata", async () => {
    const turn = deferred<CodexTurnResult>();
    let turnParams: Parameters<CodexBridge["startTurn"]>[0] | undefined;
    const codex = createCodex({
      readThreadMetadata: vi.fn(async ({ threadId }) => ({ path: `/rollouts/${threadId}.jsonl` })),
      startTurn: vi.fn((params) => {
        turnParams = params;
        void params.onTurnStarted?.("turn_1");
        return turn.promise;
      })
    });
    const { repository } = createRepository(groupConversationRecord({ codexThreadId: "thread_main" }), {
      codexThreads: [
        codexThreadRecord({
          id: 10,
          codexThreadId: "thread_main",
          conversationKey: "group_oc_group",
          name: "主会话",
          category: "main",
          mode: "plan",
          updatedAt: 100
        }),
        codexThreadRecord({
          id: 11,
          codexThreadId: "thread_topic",
          conversationKey: "group_oc_group",
          name: "Topic",
          category: "thread",
          larkThreadId: "topic_1",
          mode: "default",
          updatedAt: 300
        }),
        codexThreadRecord({
          id: 12,
          codexThreadId: "thread_side",
          conversationKey: "group_oc_group",
          name: "Side",
          category: "side",
          updatedAt: 250
        }),
        codexThreadRecord({
          id: 13,
          codexThreadId: "thread_previous",
          conversationKey: "group_oc_group",
          name: "Past Main",
          category: "previous_main",
          updatedAt: 200
        })
      ]
    });
    const manager = createManager({ repository, codex });

    try {
      manager.submitIncoming(groupMessage("g1", "hello"));
      await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

      const response = await turnParams?.onDynamicToolCall?.({
        requestId: "req_list",
        threadId: "thread_main",
        turnId: "turn_1",
        callId: "call_list",
        tool: "list_threads",
        page: 1,
        pageSize: 10,
        rawArguments: {}
      });
      const payload = dynamicToolPayload(response);

      expect(payload).toMatchObject({
        ok: true,
        conversation_key: "group_oc_group",
        page: 1,
        page_size: 10,
        has_more: false
      });
      expect(payload.threads.map((thread: { thread_id: string }) => thread.thread_id)).toEqual([
        "thread_main",
        "thread_topic",
        "thread_side",
        "thread_previous"
      ]);
      expect(payload.threads[0]).toMatchObject({
        thread_id: "thread_main",
        category: "main",
        status: "working",
        mode: "plan",
        lark_thread_id: null,
        rollout_path: "/rollouts/thread_main.jsonl"
      });
      expect(payload.threads[1]).toMatchObject({
        thread_id: "thread_topic",
        category: "thread",
        status: "idle",
        mode: "default",
        lark_thread_id: "topic_1"
      });
      expect(payload.threads[2]).toMatchObject({ category: "side" });
      expect(payload.threads[3]).toMatchObject({ category: "previous_main", lark_thread_id: null });
    } finally {
      turn.resolve(completed("thread_main", "turn_1"));
      await turn.promise;
      await waitForDelay();
    }
  });

  it("waits for a managed thread to become idle and returns final message plus latest process lines", async () => {
    const { codex, turns } = createDeferredCodex();
    const { repository } = createRepository(groupConversationRecord({ codexThreadId: "thread_main" }), {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_topic",
          conversationKey: "group_oc_group",
          category: "thread",
          larkThreadId: "topic_1",
          name: "Target"
        })
      ]
    });
    const manager = createManager({ repository, codex, config: cardModeConfig() });

    manager.submitIncoming(groupMessage("topic_msg", "target work", { chatType: "topic_group", larkThreadId: "topic_1" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(groupMessage("main_msg", "main work"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));

    const waitPromise = Promise.resolve(turns[1]!.params.onDynamicToolCall!({
      requestId: "req_wait",
      threadId: "thread_main",
      turnId: "turn_2",
      callId: "call_wait",
      tool: "wait_for_thread",
      targetThreadId: "thread_topic",
      timeoutMs: 5_000,
      rawArguments: { thread_id: "thread_topic" }
    }));
    let settled = false;
    void waitPromise.then(() => {
      settled = true;
    });
    await waitForDelay();
    expect(settled).toBe(false);

    const lines = Array.from({ length: 105 }, (_, index) => `line ${index + 1}`);
    await turns[0]!.params.onAgentMessage?.({ id: "agent_process", text: lines.join("\n"), phase: "commentary" });
    await turns[0]!.params.onAgentMessage?.({ id: "agent_final", text: "final from target", phase: "final_answer" });
    turns[0]!.resolve({ ...completed("thread_topic", "turn_1"), text: "fallback final" });

    const payload = dynamicToolPayload(await waitPromise);
    expect(payload).toMatchObject({
      ok: true,
      thread_id: "thread_topic",
      outcome: "completed",
      status: "idle",
      turn_id: "turn_1",
      final_message: "final from target",
      omitted_process_lines: 5
    });
    expect(payload.process_tail).toContain("前面省略 5 行工作过程。");
    expect(payload.process_tail.split("\n")).not.toContain("line 5");
    expect(payload.process_tail.split("\n")).toContain("line 6");
    expect(payload.process_tail.split("\n")).toContain("line 105");

    turns[1]!.resolve(completed("thread_main", "turn_2"));
    await waitForDelay();
  });

  it("returns interrupted wait output when the target thread fails", async () => {
    const { codex, turns } = createDeferredCodex();
    const { repository } = createRepository(groupConversationRecord({ codexThreadId: "thread_main" }), {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_topic",
          conversationKey: "group_oc_group",
          category: "thread",
          larkThreadId: "topic_1"
        })
      ]
    });
    const manager = createManager({ repository, codex });

    manager.submitIncoming(groupMessage("topic_msg", "target work", { chatType: "topic_group", larkThreadId: "topic_1" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await turns[0]!.params.onAgentMessage?.({ id: "agent_process", text: "before failure", phase: "commentary" });
    turns[0]!.resolve({ ...completed("thread_topic", "turn_1", "failed"), error: "boom" });
    await waitForExpect(() => expect(repository.getCodexThreadById("thread_topic")).toMatchObject({ status: "idle" }));

    manager.submitIncoming(groupMessage("main_msg", "main work"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    const payload = dynamicToolPayload(await turns[1]!.params.onDynamicToolCall!({
      requestId: "req_wait",
      threadId: "thread_main",
      turnId: "turn_2",
      callId: "call_wait",
      tool: "wait_for_thread",
      targetThreadId: "thread_topic",
      timeoutMs: 5_000,
      rawArguments: { thread_id: "thread_topic" }
    }));

    expect(payload).toMatchObject({
      ok: true,
      thread_id: "thread_topic",
      outcome: "interrupted",
      interrupted_reason: "failed",
      process_tail: "before failure"
    });
    expect(payload).not.toHaveProperty("final_message");

    turns[1]!.resolve(completed("thread_main", "turn_2"));
    await waitForDelay();
  });

  it("forwards normal thread references and rejects unbound thread references", async () => {
    const turn = deferred<CodexTurnResult>();
    let turnParams: Parameters<CodexBridge["startTurn"]>[0] | undefined;
    const codex = createCodex({
      startTurn: vi.fn((params) => {
        turnParams = params;
        void params.onTurnStarted?.("turn_1");
        return turn.promise;
      })
    });
    const { repository } = createRepository(groupConversationRecord({ codexThreadId: "thread_main" }), {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_topic",
          conversationKey: "group_oc_group",
          category: "thread",
          larkThreadId: "topic_1"
        }),
        codexThreadRecord({
          codexThreadId: "thread_unbound",
          conversationKey: "group_oc_group",
          category: "thread"
        })
      ]
    });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    try {
      manager.submitIncoming(groupMessage("g1", "hello"));
      await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

      const okPayload = dynamicToolPayload(await turnParams?.onDynamicToolCall?.({
        requestId: "req_ref",
        threadId: "thread_main",
        turnId: "turn_1",
        callId: "call_ref",
        tool: "send_thread_ref",
        targetThreadId: "thread_topic",
        rawArguments: { thread_id: "thread_topic" }
      }));
      expect(okPayload).toMatchObject({
        ok: true,
        thread_id: "thread_topic",
        lark_thread_id: "topic_1",
        destination: { type: "chat", id: "oc_group" }
      });
      expect(lark.forwardThread).toHaveBeenCalledWith("topic_1", "oc_group", "chat_id", {
        uuid: expect.stringMatching(UUID_PATTERN)
      });

      const errorResponse = await turnParams?.onDynamicToolCall?.({
        requestId: "req_ref_bad",
        threadId: "thread_main",
        turnId: "turn_1",
        callId: "call_ref_bad",
        tool: "send_thread_ref",
        targetThreadId: "thread_unbound",
        rawArguments: { thread_id: "thread_unbound" }
      });
      expect(errorResponse).toMatchObject({ success: false });
      expect(dynamicToolPayload(errorResponse)).toMatchObject({
        ok: false,
        error: { code: "THREAD_NOT_FORWARDABLE" }
      });
    } finally {
      turn.resolve(completed("thread_main", "turn_1"));
      await turn.promise;
      await waitForDelay();
    }
  });

  it("creates a new Twinny conversation group from an owner-profile dynamic tool call", async () => {
    const turn = deferred<CodexTurnResult>();
    let turnParams: Parameters<CodexBridge["startTurn"]>[0] | undefined;
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_new_conversation" })),
      startTurn: vi.fn((params) => {
        turnParams = params;
        void params.onTurnStarted?.("turn_1");
        return turn.promise;
      })
    });
    const { repository } = createRepository(groupConversationRecord({
      codexThreadId: "thread_main",
      profile: "host"
    }));
    const larkChats: LarkChatDirectory = {
      createChat: vi.fn(async () => ({ chatId: "oc_new", raw: {} })),
      getChatLink: vi.fn(async () => "https://fsopen.bytedance.net/share/oc_new")
    };
    const manager = createManager({ repository, codex, larkChats });

    try {
      manager.submitIncoming(groupMessage("g1", "hello", { senderOpenId: "ou_owner", senderName: "Owner" }));
      await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

      const payload = dynamicToolPayload(await turnParams?.onDynamicToolCall?.({
        requestId: "req_create",
        threadId: "thread_main",
        turnId: "turn_1",
        callId: "call_create",
        tool: "create_conversation",
        name: "New Project",
        memberOpenIds: ["ou_extra"],
        responseMode: "owner",
        profile: "guest",
        rawArguments: { name: "New Project", member_open_ids: ["ou_extra"] }
      }));

      expect(larkChats.createChat).toHaveBeenCalledWith(expect.objectContaining({
        name: "New Project",
        ownerOpenId: "ou_owner",
        userOpenIds: ["ou_owner", "ou_extra"],
        groupMessageType: "chat",
        setBotManager: true,
        uuid: expect.stringMatching(UUID_PATTERN)
      }));
      expect(larkChats.getChatLink).toHaveBeenCalledWith("oc_new");
      expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({
        profile: "guest",
        cwd: "/tmp/twinny/workspaces/group_oc_new",
        approvalPolicy: "never"
      }));
      expect(repository.findByConversationKey("group_oc_new")).toMatchObject({
        conversationKey: "group_oc_new",
        chatId: "oc_new",
        name: "New Project",
        responseMode: "owner",
        profile: "guest",
        codexThreadId: "thread_new_conversation"
      });
      expect(payload).toMatchObject({
        ok: true,
        conversation: {
          conversation_key: "group_oc_new",
          chat_id: "oc_new",
          workspace: "/tmp/twinny/workspaces/group_oc_new",
          response_mode: "owner",
          profile: "guest",
          codex_thread_id: "thread_new_conversation",
          share_link: "https://fsopen.bytedance.net/share/oc_new"
        }
      });
    } finally {
      turn.resolve(completed("thread_main", "turn_1"));
      await turn.promise;
      await waitForDelay();
    }
  });

  it("applies a Codex thread name update that arrives before the thread card is stored", async () => {
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
    const { repository } = createRepository(row);
    const codex = createCodex({ startThread: vi.fn(async () => ({ threadId: "thread_pending_name" })) });
    const lark = createLarkResponder();
    vi.mocked(lark.replyText).mockResolvedValueOnce({
      messageId: "reply_pending_name_1",
      raw: { data: { thread_id: "topic_pending_name" } }
    });
    const manager = createManager({ repository, codex, lark });

    manager.submitCodexThreadNameUpdated({ threadId: "thread_pending_name", name: "  [twinny] Codex 生成标题  " });
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
    expect(repository.updateCodexThreadCard).toHaveBeenCalledWith(expect.objectContaining({
      conversationKey: "group_oc_group",
      codexThreadId: "thread_pending_name",
      profile: "host",
      name: "Codex 生成标题",
      creatorOpenId: "ou_guest"
    }));
    await expect(Promise.resolve(repository.getCodexThreadById("thread_pending_name"))).resolves.toMatchObject({
      name: "Codex 生成标题"
    });
    expect(repository.updateCodexThreadCard).toHaveBeenLastCalledWith(expect.objectContaining({
      conversationKey: "group_oc_group",
      codexThreadId: "thread_pending_name",
      profile: "host",
      larkThreadId: "topic_pending_name",
      creatorOpenId: "ou_guest",
      cardMessageId: "card_oc_group_1"
    }));
  });

  it("patches a thread card when Codex renames it before the card message id is stored", async () => {
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
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

    manager.submitCodexThreadNameUpdated({ threadId: "thread_inflight_name", name: "[twinny] Codex 补发标题" });
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

  it("keeps turn usage on the start message after steering", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository, codex });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "second"));
    await waitForExpect(() => expect(codex.steerTurn).toHaveBeenCalledTimes(1));

    const raw = {
      threadId: "thread_1",
      turnId: "turn_1",
      tokenUsage: {
        total: {
          totalTokens: 84,
          inputTokens: 60,
          cachedInputTokens: 20,
          outputTokens: 24,
          reasoningOutputTokens: 6
        }
      }
    };
    await turns[0]!.params.onTokenUsage?.({
      threadId: "thread_1",
      turnId: "turn_1",
      totalTokens: 84,
      raw
    });

    expect(repository.updateLarkMessageTokenUsage).toHaveBeenCalledWith({
      larkMessageId: "m1",
      inputTokens: 60,
      outputTokens: 24,
      cachedInputTokens: 20,
      reasoningOutputTokens: 6,
      tokenUsageJson: JSON.stringify(raw)
    });
    expect(vi.mocked(repository.updateLarkMessageTokenUsage).mock.calls.some(([input]) => input.larkMessageId === "m2")).toBe(false);

    turns[0]!.resolve(completed("thread_1", "turn_1"));
  });

  it("falls back to the latest steer message when the active usage target is missing", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const logger = createLogger();
    const manager = createManager({ repository, codex, logger });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(message("m2", "second"));
    await waitForExpect(() => expect(codex.steerTurn).toHaveBeenCalledTimes(1));

    vi.mocked(repository.updateLarkMessageTokenUsage).mockImplementation((input) => {
      if (input.larkMessageId === "m1") {
        return undefined;
      }
      return larkMessageRecord({
        larkMessageId: input.larkMessageId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedInputTokens: input.cachedInputTokens,
        reasoningOutputTokens: input.reasoningOutputTokens,
        tokenUsageJson: input.tokenUsageJson
      });
    });

    const raw = {
      threadId: "thread_1",
      turnId: "turn_1",
      tokenUsage: {
        total: {
          totalTokens: 84,
          inputTokens: 60,
          cachedInputTokens: 20,
          outputTokens: 24,
          reasoningOutputTokens: 6
        }
      }
    };
    await turns[0]!.params.onTokenUsage?.({
      threadId: "thread_1",
      turnId: "turn_1",
      totalTokens: 84,
      raw
    });

    expect(repository.updateCodexThreadTokenUsage).toHaveBeenCalledWith(expect.objectContaining({
      codexThreadId: "thread_1",
      inputTokens: 60,
      outputTokens: 24
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread_1", turnId: "turn_1", messageId: "m1" }),
      "failed to record lark message token usage because target message was not found; trying latest steer message"
    );
    expect(repository.updateLarkMessageTokenUsage).toHaveBeenCalledWith({
      larkMessageId: "m2",
      inputTokens: 60,
      outputTokens: 24,
      cachedInputTokens: 20,
      reasoningOutputTokens: 6,
      tokenUsageJson: JSON.stringify(raw)
    });

    turns[0]!.resolve(completed("thread_1", "turn_1"));
  });

  it("keeps explicitly queued different-user messages ordered before a later trigger-user message", async () => {
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository: createRepository(groupConversationRecord()).repository, codex });

    manager.submitIncoming(groupMessage("g1", "active", { senderOpenId: "ou_guest" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    manager.submitIncoming(groupMessage("g2", "/queue other queued", { senderOpenId: "ou_other" }));
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

  it("enables queue mode from empty /queue and queues the next ordinary message", async () => {
    const { repository } = createRepository();
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    manager.submitIncoming(message("m2", "/queue"));
    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith(
        "m2",
        "已开启排队模式：你的下一条消息会排队等待当前工作结束。"
      )
    );

    manager.submitIncoming(message("m3", "queued after mode"));
    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));

    expect(codex.steerTurn).not.toHaveBeenCalled();
    await waitForExpect(() =>
      expect(repository.insertLarkMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          larkMessageId: "m3",
          routeKind: "queued_message",
          status: "queued",
          text: "queued after mode"
        })
      )
    );

    turns[0]!.resolve(completed("thread_1", "turn_1"));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(2));
    expect(codex.startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ input: wrappedMessage("queued after mode", "m3") })
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
        profile: "guest",
        threadId: "thread_1",
        objective: "implement the queued target"
      })
    );

    goals[0]!.resolve({ ...completed("thread_1", "goal_1"), text: "goal done" });
    await waitForExpect(() => expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m1"]));
  });

  it("binds /watch to the current thread, supports none mode, and lists watchers as a post table", async () => {
    const { repository } = createRepository(conversationRecord());
    const lark = createLarkResponder();
    const larkDocs = createLarkDocResolver();
    const manager = createManager({ repository, lark, larkDocs });

    manager.submitIncoming(message("m_watch", "/watch https://example.feishu.cn/docx/doc_token"));

    await waitForExpect(() =>
      expect(repository.upsertLarkDocWatcher).toHaveBeenCalledWith({
        fileType: "docx",
        fileToken: "doc_token",
        threadId: "thread_1",
        watchMode: "owner",
        watchUrl: "https://example.feishu.cn/docx/doc_token"
      })
    );
    expect(lark.replyText).toHaveBeenCalledWith("m_watch", "已监听 docx/doc_token，mode=owner。");

    manager.submitIncoming(message("m_watch_none", "/watch https://example.feishu.cn/docx/doc_token none"));
    await waitForExpect(() =>
      expect(repository.upsertLarkDocWatcher).toHaveBeenCalledWith(
        expect.objectContaining({
          fileToken: "doc_token",
          watchMode: "none"
        })
      )
    );
    expect(lark.replyText).toHaveBeenCalledWith("m_watch_none", "已关闭 docx/doc_token 的文档评论监听。");

    manager.submitIncoming(message("m_watch_other", "/watch https://example.feishu.cn/docx/other_doc all"));
    await waitForExpect(() =>
      expect(repository.upsertLarkDocWatcher).toHaveBeenCalledWith(
        expect.objectContaining({
          fileToken: "other_doc",
          watchMode: "all"
        })
      )
    );
    repository.touchLarkDocWatcherCommentReceived("docx", "other_doc", Date.UTC(2025, 0, 1));

    manager.submitIncoming(message("m_watch_list", "/watch"));
    await waitForExpect(() =>
      expect(lark.replyPost).toHaveBeenCalledWith(
        "m_watch_list",
        [[{ tag: "md", text: expect.stringContaining("| URL | 状态 | 最新评论时间（北京时间） |") }]]
      )
    );
    const watchListPost = vi.mocked(lark.replyPost).mock.calls.find(([messageId]) => messageId === "m_watch_list")?.[1];
    const watchListMarkdown = watchListPost?.[0]?.[0]?.tag === "md" ? watchListPost[0][0].text : "";
    expect(watchListMarkdown).toContain("| https://example.feishu.cn/docx/other_doc | all | 2025-01-01 08:00:00 |");
    expect(watchListMarkdown).toContain("| https://example.feishu.cn/docx/doc_token | none | 暂无 |");
    expect(vi.mocked(lark.replyText).mock.calls.find(([messageId]) => messageId === "m_watch_list")).toBeUndefined();
  });

  it("adds document watch configuration hints without blocking /watch", async () => {
    const { repository } = createRepository(conversationRecord());
    const lark = createLarkResponder();
    const larkDocs = createLarkDocResolver();
    const larkFeatureConfig: LarkFeatureConfigurationStatusProvider = {
      checkFeatureSet: vi.fn(async () => missingFeatureResult("doc_watch", "文档监听", {
        missingScopes: ["docs:document.media:download"],
        scopeApplyUrl: "https://open.larkoffice.com/page/scope-apply?clientID=cli_xxx&scopes=docs%3Adocument.media%3Adownload"
      }))
    };
    const manager = createManager({ repository, lark, larkDocs, larkFeatureConfig });

    manager.submitIncoming(message("m_watch", "/watch https://example.feishu.cn/docx/doc_token"));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith(
        "m_watch",
        expect.stringContaining("已监听 docx/doc_token，mode=owner。")
      )
    );
    expect(lark.replyText).toHaveBeenCalledWith(
      "m_watch",
      expect.stringContaining("bot 无法看到文档中的图片")
    );
    expect(repository.upsertLarkDocWatcher).toHaveBeenCalledWith(expect.objectContaining({ fileToken: "doc_token" }));
    expect(larkFeatureConfig.checkFeatureSet).toHaveBeenCalledWith("doc_watch");
  });

  it("processes mentioned watched doc comments, exits plan mode at start, and replies to the document", async () => {
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [codexThreadRecord({ codexThreadId: "thread_1", mode: "plan" })]
    });
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_1",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    const lark = createLarkResponder();
    const larkDocComments = createLarkDocCommentClient(larkDocCommentSnapshot({
      text: "@ou_bot Please fix <this> with @ou_reviewer and @ouid_extra",
      quote: "Quoted & referenced text",
      quoteBlockIds: ["block_1", "block_2"]
    }));
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted }) => {
        await onTurnStarted?.("turn_doc");
        return { ...completed(threadId, "turn_doc"), text: "Final answer for doc" };
      })
    });
    const manager = createManager({ repository, codex, lark, larkDocComments, botOpenId: "ou_bot" });

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_doc_comment",
      senderOpenId: "ou_owner",
      senderName: "Owner",
      isMentioned: true
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(repository.updateCodexThreadMode).toHaveBeenCalledWith("p2p_ou_guest", "thread_1", "default");
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "default",
        input: expect.stringContaining('<lark-doc-comment sender_id="ou_owner" sender_name="Owner" file_type="docx" file_token="doc_token" comment_id="comment_1">')
      })
    );
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.stringContaining('<quote blocks="block_1,block_2">Quoted &amp; referenced text</quote>')
      })
    );
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.stringContaining("@ou_bot Please fix &lt;this&gt; with @ou_reviewer and @ouid_extra")
      })
    );
    expect(lark.sendTextToOpenId).not.toHaveBeenCalled();
    expect(lark.sendPostToOpenId).not.toHaveBeenCalled();
    expect(lark.sendCardToOpenId).toHaveBeenCalledWith(
      "ou_guest",
      expect.objectContaining({ schema: "2.0" }),
      { uuid: expect.stringMatching(UUID_PATTERN) }
    );
    const card = vi.mocked(lark.sendCardToOpenId).mock.calls[0]![1] as Record<string, unknown>;
    expect(card.header).toMatchObject({
      subtitle: { tag: "plain_text", content: "文档评论触发" }
    });
    expect(JSON.stringify(card)).toContain(
      "[收到文档评论] <at id=ou_owner></at> 在 <link url='https://example.feishu.cn/docx/doc_token'>https://example.feishu.cn/docx/doc&#95;token</link> 中评论: Please fix &lt;this&gt; with <at id=ou_reviewer></at> and <at id=ouid_extra></at>"
    );
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "doc_comment:event_doc_comment:comment_1:reply_1",
        docCommentId: "comment_1",
        routeKind: "doc_comment",
        status: "processing",
        codexThreadId: "thread_1"
      })
    );
    await waitForExpect(() =>
      expect(larkDocComments.updateReaction).toHaveBeenCalledWith({
        fileType: "docx",
        fileToken: "doc_token",
        replyId: "reply_1",
        reactionType: config.lark.workingReaction,
        action: "add"
      })
    );
    await waitForExpect(() =>
      expect(larkDocComments.replyToComment).toHaveBeenCalledWith({
        fileType: "docx",
        fileToken: "doc_token",
        commentId: "comment_1",
        isWhole: false,
        text: "Final answer for doc"
      })
    );
    const completedCard = vi.mocked(lark.patchCard).mock.calls.find(([, patched]) =>
      JSON.stringify(patched).includes("Final answer for doc")
    )?.[1] as Record<string, unknown>;
    expect(completedCard.header).toMatchObject({
      subtitle: { tag: "plain_text", content: "文档评论触发" }
    });
    const completedBodyElements = (completedCard.body as { elements: Array<Record<string, unknown>> }).elements;
    expect(completedBodyElements[0]?.tag).toBe("collapsible_panel");
    expect(JSON.stringify(completedBodyElements[0])).toContain("[收到文档评论] <at id=ou_owner></at>");
    expect(lark.recallMessage).not.toHaveBeenCalledWith("card_ou_guest_1");
  });

  it("prepends the fork boundary before the first watched doc comment in a forked thread", async () => {
    const { repository } = createRepository(groupConversationRecord(), {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_parent",
          conversationKey: "group_oc_group",
          larkThreadId: "topic_parent"
        }),
        codexThreadRecord({
          codexThreadId: "thread_forked",
          conversationKey: "group_oc_group",
          larkThreadId: "topic_forked",
          forkedFromCodexThreadId: "thread_parent"
        })
      ]
    });
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_forked",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    const larkDocComments = createLarkDocCommentClient(larkDocCommentSnapshot({
      commentId: "comment_fork",
      replyId: "reply_fork",
      text: "Review this forked doc path"
    }));
    const codex = createCodex();
    const manager = createManager({ repository, codex, larkDocComments });

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_fork_doc",
      commentId: "comment_fork",
      replyId: "reply_fork"
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    const input = vi.mocked(codex.startTurn).mock.calls[0]![0].input;
    expect(input).toEqual(expect.stringContaining("Fork conversation boundary."));
    expect(input).toEqual(expect.stringContaining("Review this forked doc path"));
    expect(repository.hasUserMessageForCodexThread).toHaveBeenCalledWith(
      "thread_forked",
      ["doc_comment:event_fork_doc:comment_fork:reply_fork"]
    );
  });

  it("sends watched doc comments as turn cards while preserving images for Codex", async () => {
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [codexThreadRecord({ codexThreadId: "thread_1" })]
    });
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_1",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    const lark = createLarkResponder();
    const larkDocComments = createLarkDocCommentClient(larkDocCommentSnapshot({
      text: "@ou_bot Please inspect @ou_reviewer",
      imageKeys: ["img_1", "img_2"]
    }));
    const larkFiles: LarkFileDownloader = {
      downloadMessageResource: vi.fn(async ({ outputDir }) => ({
        path: path.join(outputDir, "unused.png"),
        resourceType: "image" as const,
        fileKey: "unused",
        fileName: "unused.png",
        size: 1,
        contentType: "image/png"
      })),
      uploadImage: vi.fn(async ({ fileName }) => ({
        imageKey: `uploaded_${fileName?.replace(/\.png$/, "")}`
      }))
    };
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId }) => ({ ...completed(threadId, "turn_doc"), text: "Final answer for doc" }))
    });
    const manager = createManager({ repository, codex, lark, larkDocComments, larkFiles, botOpenId: "ou_bot" });

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_doc_comment",
      senderOpenId: "ou_owner",
      senderName: "Owner",
      isMentioned: true
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(larkDocComments.downloadCommentImage).toHaveBeenCalledWith({
      fileToken: "img_1",
      outputDir: expect.stringContaining(path.join("doc_comments", "comment_1")),
      driveRouteToken: undefined,
      fileName: undefined
    });
    expect(larkFiles.uploadImage).not.toHaveBeenCalled();
    expect(lark.sendCardToOpenId).toHaveBeenCalledWith(
      "ou_guest",
      expect.objectContaining({ schema: "2.0" }),
      { uuid: expect.stringMatching(UUID_PATTERN) }
    );
    expect(lark.sendPostToOpenId).not.toHaveBeenCalled();
    expect(lark.sendTextToOpenId).not.toHaveBeenCalled();
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "doc_comment:event_doc_comment:comment_1:reply_1",
        routeKind: "doc_comment",
        status: "processing",
        codexThreadId: "thread_1"
      })
    );
    const startTurnInput = vi.mocked(codex.startTurn).mock.calls[0]?.[0].input;
    expect(JSON.stringify(startTurnInput)).toContain(
      "/tmp/twinny/workspaces/p2p_ou_guest/.twinny/lark_files/doc_comments/comment_1/img_1.png"
    );
  });

  it("steers watched doc comments from the active comment block into the current turn", async () => {
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [codexThreadRecord({ codexThreadId: "thread_1" })]
    });
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_1",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const larkDocComments = createLarkDocCommentClient();
    vi.mocked(larkDocComments.getCommentSnapshot)
      .mockResolvedValueOnce(larkDocCommentSnapshot({ replyId: "reply_1", text: "First doc request" }))
      .mockResolvedValueOnce(larkDocCommentSnapshot({ replyId: "reply_2", text: "Follow-up same block" }));
    const manager = createManager({ repository, codex, lark, larkDocComments });

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_doc_comment_1",
      replyId: "reply_1"
    }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_doc_comment_2",
      replyId: "reply_2",
      createTime: 1235
    }));

    await waitForExpect(() =>
      expect(codex.steerTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread_1",
          turnId: "turn_1",
          input: expect.stringContaining("Follow-up same block")
        })
      )
    );
    expect(codex.startTurn).toHaveBeenCalledTimes(1);
    expect(manager.queueDepth("p2p_ou_guest")).toBe(0);
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "doc_comment:event_doc_comment_2:comment_1:reply_2",
        routeKind: "doc_comment_reply_steer",
        status: "processing",
        codexThreadId: "thread_1"
      })
    );
    await waitForExpect(() => expect(lark.patchCard).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(lark.patchCard).mock.calls)).toContain(
      "[新增评论] <at id=ou_owner></at>: Follow-up same block"
    );
    await waitForExpect(() =>
      expect(larkDocComments.updateReaction).toHaveBeenCalledWith({
        fileType: "docx",
        fileToken: "doc_token",
        replyId: "reply_2",
        reactionType: config.lark.workingReaction,
        action: "add"
      })
    );
    await waitForExpect(() =>
      expect(repository.markLarkMessagesSteered).toHaveBeenCalledWith(["doc_comment:event_doc_comment_1:comment_1:reply_1"], {
        conversationKey: "p2p_ou_guest",
        codexThreadId: "thread_1",
        codexTurnId: "turn_1"
      })
    );
    await waitForExpect(() =>
      expect(larkDocComments.updateReaction).toHaveBeenCalledWith({
        fileType: "docx",
        fileToken: "doc_token",
        replyId: "reply_1",
        reactionType: config.lark.workingReaction,
        action: "delete"
      })
    );

    turns[0]!.resolve({ ...completed("thread_1", "turn_1"), text: "Final doc answer" });
    await waitForExpect(() =>
      expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["doc_comment:event_doc_comment_2:comment_1:reply_2"])
    );
    await waitForExpect(() =>
      expect(larkDocComments.replyToComment).toHaveBeenCalledWith({
        fileType: "docx",
        fileToken: "doc_token",
        commentId: "comment_1",
        isWhole: false,
        text: "Final doc answer"
      })
    );
  });

  it("replies final output to the document when a doc-comment turn is steered by a conversation message", async () => {
    const { repository } = createRepository(groupConversationRecord());
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_group",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    const lark = createLarkResponder();
    const larkDocComments = createLarkDocCommentClient(larkDocCommentSnapshot());
    const { codex, turns } = createDeferredCodex();
    const manager = createManager({ repository, codex, lark, larkDocComments, botOpenId: "ou_bot" });

    manager.submitDocCommentAdd(docCommentAdd({
      senderOpenId: "ou_owner",
      senderName: "Owner",
      isMentioned: true
    }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    manager.submitIncoming(groupMessage("m_steer", "extra context", { senderOpenId: "ou_owner", senderName: "Owner" }));
    await waitForExpect(() =>
      expect(codex.steerTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread_group",
          turnId: "turn_1",
          input: '<lark_message lark_message_id="m_steer" timestamp="1234" sender_ouid="ou_owner" sender_name="Owner">\nextra context\n</lark_message>'
        })
      )
    );
    await waitForExpect(() =>
      expect(repository.markLarkMessagesSteered).toHaveBeenCalledWith(["doc_comment:event_doc_comment:comment_1:reply_1"], {
        conversationKey: "group_oc_group",
        codexThreadId: "thread_group",
        codexTurnId: "turn_1"
      })
    );
    await waitForExpect(() =>
      expect(larkDocComments.updateReaction).toHaveBeenCalledWith({
        fileType: "docx",
        fileToken: "doc_token",
        replyId: "reply_1",
        reactionType: config.lark.workingReaction,
        action: "delete"
      })
    );

    turns[0]!.resolve({ ...completed("thread_group", "turn_1"), text: "Final answer after steer" });

    await waitForExpect(() =>
      expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m_steer"])
    );
    await waitForExpect(() =>
      expect(larkDocComments.replyToComment).toHaveBeenCalledWith({
        fileType: "docx",
        fileToken: "doc_token",
        commentId: "comment_1",
        isWhole: false,
        text: "Final answer after steer"
      })
    );
  });

  it("queues watched doc comments from a different comment block while a doc turn is active", async () => {
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [codexThreadRecord({ codexThreadId: "thread_1" })]
    });
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_1",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const larkDocComments = createLarkDocCommentClient();
    vi.mocked(larkDocComments.getCommentSnapshot)
      .mockResolvedValueOnce(larkDocCommentSnapshot({ commentId: "comment_1", replyId: "reply_1" }))
      .mockResolvedValueOnce(larkDocCommentSnapshot({ commentId: "comment_2", replyId: "reply_2" }));
    const manager = createManager({ repository, codex, lark, larkDocComments });

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_doc_comment_1",
      commentId: "comment_1",
      replyId: "reply_1"
    }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_doc_comment_2",
      commentId: "comment_2",
      replyId: "reply_2",
      createTime: 1235
    }));

    await waitForExpect(() => expect(manager.queueDepth("p2p_ou_guest")).toBe(1));
    expect(codex.steerTurn).not.toHaveBeenCalled();
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "doc_comment:event_doc_comment_2:comment_2:reply_2",
        routeKind: "doc_comment",
        status: "queued",
        codexThreadId: "thread_1"
      })
    );

    turns[0]!.resolve(completed("thread_1", "turn_1"));
  });

  it("processes all-mode watched doc comments from non-owner senders", async () => {
    const { repository } = createRepository(conversationRecord());
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_1",
      watchMode: "all",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    const lark = createLarkResponder();
    const larkDocComments = createLarkDocCommentClient(larkDocCommentSnapshot({
      authorOpenId: "ou_reviewer",
      authorName: "Reviewer",
      text: "@Twinny please check this"
    }));
    const codex = createCodex();
    const manager = createManager({ repository, codex, lark, larkDocComments });

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_doc_comment_reviewer",
      senderOpenId: "ou_reviewer",
      senderName: "Reviewer",
      isMentioned: true
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.stringContaining('<lark-doc-comment sender_id="ou_reviewer" sender_name="Reviewer"')
      })
    );
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkUserId: "ou_reviewer",
        routeKind: "doc_comment"
      })
    );
  });

  it("renders doc block images inside quote without sending them as local images", async () => {
    const { repository } = createRepository(conversationRecord());
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_1",
      watchMode: "all",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    const lark = createLarkResponder();
    const larkDocComments = createLarkDocCommentClient(larkDocCommentSnapshot({
      text: "@Twinny 图里是啥",
      quote: "[图片]",
      quoteBlockIds: ["image_block"],
      imageKeys: ["image_token"],
      imageRefs: [
        {
          fileToken: "image_token",
          source: "doc_block",
          blockId: "image_block",
          driveRouteToken: "doc_token",
          fileName: "doc-image-image_block"
        }
      ]
    }));
    const codex = createCodex();
    const manager = createManager({ repository, codex, lark, larkDocComments, botOpenId: "ou_bot" });

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_doc_comment_image",
      senderOpenId: "ou_owner",
      senderName: "Owner",
      isMentioned: true
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(larkDocComments.downloadCommentImage).toHaveBeenCalledWith({
      fileToken: "image_token",
      outputDir: expect.stringContaining(path.join("doc_comments", "comment_1")),
      driveRouteToken: "doc_token",
      fileName: "doc-image-image_block"
    });
    const input = vi.mocked(codex.startTurn).mock.calls[0]?.[0].input;
    expect(typeof input).toBe("string");
    if (typeof input !== "string") {
      throw new Error("expected doc image quote input to remain text");
    }
    expect(input).toContain('<quote blocks="image_block">[图片]\n<doc_image block_id="image_block"><img filekey="image_token"');
    expect(input).toContain(">Saved locally</img></doc_image></quote>");
    expect(input).toContain("image_token.png");
    expect(JSON.stringify(input)).not.toContain("localImage");
  });

  it("ignores watched doc comments unless the comment mentions the bot", async () => {
    const { repository } = createRepository(conversationRecord());
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_1",
      watchMode: "all",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    const codex = createCodex();
    const larkDocComments = createLarkDocCommentClient();
    const manager = createManager({ repository, codex, larkDocComments });

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_doc_comment_reply_to_bot",
      replyId: "reply_to_bot",
      isMentioned: false
    }));

    await waitForDelay();
    expect(larkDocComments.getCommentSnapshot).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
  });

  it("processes unmentioned watched doc comment replies after the comment block has history", async () => {
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [codexThreadRecord({ codexThreadId: "thread_1" })],
      larkMessages: [
        larkMessageRecord({
          larkMessageId: "proxy_doc_comment_1",
          eventId: "event_doc_comment_1",
          routeKind: "doc_comment",
          docCommentId: "comment_1",
          codexThreadId: "thread_1"
        })
      ]
    });
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_1",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    const lark = createLarkResponder();
    const larkDocComments = createLarkDocCommentClient(larkDocCommentSnapshot({
      replyId: "reply_2",
      text: "Follow-up same block",
      rawReply: { reply_id: "reply_2", content: { text: "Follow-up same block" } }
    }));
    const codex = createCodex();
    const manager = createManager({ repository, codex, lark, larkDocComments, botOpenId: "ou_bot" });

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_doc_comment_2",
      replyId: "reply_2",
      isMentioned: false
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(repository.hasProcessedDocComment).toHaveBeenCalledWith("comment_1");
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.stringContaining("Follow-up same block")
      })
    );
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "doc_comment:event_doc_comment_2:comment_1:reply_2",
        docCommentId: "comment_1",
        routeKind: "doc_comment",
        status: "processing",
        codexThreadId: "thread_1"
      })
    );
  });

  it("ignores unmentioned watched doc comment replies in a processed block when they mention someone else", async () => {
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [codexThreadRecord({ codexThreadId: "thread_1" })],
      larkMessages: [
        larkMessageRecord({
          larkMessageId: "proxy_doc_comment_1",
          eventId: "event_doc_comment_1",
          routeKind: "doc_comment",
          docCommentId: "comment_1",
          codexThreadId: "thread_1"
        })
      ]
    });
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_1",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    const lark = createLarkResponder();
    const larkDocComments = createLarkDocCommentClient(larkDocCommentSnapshot({
      replyId: "reply_2",
      text: "Looping in @ou_reviewer",
      rawReply: {
        reply_id: "reply_2",
        content: {
          elements: [
            { type: "text_run", text_run: { text: "Looping in " } },
            { type: "person", person: { user_id: "ou_reviewer", name: "Reviewer" } }
          ]
        }
      }
    }));
    const codex = createCodex();
    const manager = createManager({ repository, codex, lark, larkDocComments, botOpenId: "ou_bot" });

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_doc_comment_2",
      replyId: "reply_2",
      isMentioned: false
    }));

    await waitForExpect(() => expect(larkDocComments.getCommentSnapshot).toHaveBeenCalledTimes(1));
    await waitForDelay();
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(lark.sendTextToOpenId).not.toHaveBeenCalled();
    expect(repository.insertLarkMessage).not.toHaveBeenCalled();
  });

  it("keeps owner-mode doc comment follow-ups restricted to the owner", async () => {
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [codexThreadRecord({ codexThreadId: "thread_1" })],
      larkMessages: [
        larkMessageRecord({
          larkMessageId: "proxy_doc_comment_1",
          eventId: "event_doc_comment_1",
          routeKind: "doc_comment",
          docCommentId: "comment_1",
          codexThreadId: "thread_1"
        })
      ]
    });
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_1",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });
    const larkDocComments = createLarkDocCommentClient();
    const codex = createCodex();
    const manager = createManager({ repository, codex, larkDocComments });

    manager.submitDocCommentAdd(docCommentAdd({
      eventId: "event_doc_comment_2",
      replyId: "reply_2",
      senderOpenId: "ou_reviewer",
      senderName: "Reviewer",
      isMentioned: false
    }));

    await waitForDelay();
    expect(repository.hasProcessedDocComment).not.toHaveBeenCalled();
    expect(larkDocComments.getCommentSnapshot).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
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
        profile: "guest",
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

  it("runs a same-user /compact directly while plan waiting without queued reactions", async () => {
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
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark });

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
        expect.objectContaining({ profile: "guest", threadId: "thread_1", turnId: "turn_1" })
      )
    );
    expect(lark.addQueuedReaction).not.toHaveBeenCalled();
    expect(manager.queueDepth("p2p_ou_guest")).toBe(0);
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
    manager.submitIncoming(groupMessage("m_queue", "/queue", { senderOpenId: "ou_other" }));
    await waitForExpect(() => expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m_queue"]));
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
    expect(lark.replyText).not.toHaveBeenCalled();
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
    const helpText = vi.mocked(lark.replyText).mock.calls[0]?.[1] ?? "";
    for (const usage of [
      "/help - 查看可用指令和使用说明",
      "/status - 查看当前会话、Codex thread 和 token 用量",
      "/new - 新开 Codex thread；会停止当前任务并清空待处理消息",
      "/stop [all|<side_id>] - 停止当前任务并清空待处理消息；可停止全部或指定临时会话",
      "/next - 打断当前任务，并执行队列中的下一条消息",
      "/steer - 将队列中的下一批消息注入当前任务",
      "/queue [message] - 不带 message 时开启排队模式；带 message 时将消息加入下一轮队列",
      "/goal <objective> - 设置并自动实现 Codex goal；运行中再次使用会更新目标",
      "/plan [message] - 开启 plan mode；带 message 时直接以 plan mode 处理",
      "/exit - 退出 plan mode；默认加入下一轮队列",
      "/side <message> 或 /btw <message> - 基于当前 Codex thread 发起临时会话",
      "/compact - 压缩当前 Codex thread 上下文；默认加入下一轮队列",
      "/logo - 发送 Twinny logo.png",
      "/twinny 或 /banner - 发送 Twinny banner 卡片",
      "/thread [message] - 创建新话题",
      "/fork [message] - 从当前 Codex thread fork 出新话题",
      "/watch <lark_doc_url> [owner|all|none] - 监听文档 @bot 评论；不带参数查看当前 thread 监听"
    ]) {
      expect(helpText).toContain(usage);
    }
    expect(helpText).not.toContain("/activate all_at guest");
    expect(helpText).not.toContain("/deactivate");
    expect(codex.startTurn).not.toHaveBeenCalled();
  });

  it("runs /reload without waiting on its own control queue", async () => {
    const { repository } = createRepository();
    const lark = createLarkResponder();
    let manager!: ConversationManager;
    const runtime: ConstructorParameters<typeof ConversationManager>[0]["runtime"] = {
      reloadProfile: vi.fn(async (_profile, options) => {
        await manager.suspendActiveTurnsForCodexAppServerExit("host", options);
        await manager.recoverSuspendedActiveTurnsForCodexAppServerExit("host", options);
      })
    };
    manager = createManager({ repository, lark, runtime });

    manager.submitIncoming(message("m_reload", "/reload", {
      senderOpenId: "ou_owner",
      senderName: "Owner"
    }));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("m_reload", "已 reload 全部 profiles。")
    );
    expect(runtime.reloadProfile).toHaveBeenCalledWith(undefined, { inlineStateKey: "p2p_ou_owner" });
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m_reload"]);
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

  it("sends /twinny and /banner directly to the source chat with the banner card", async () => {
    const lark = createLarkResponder();
    const manager = createManager({ lark, assetImageKeys: { bannerImageKey: "img_banner" } });

    manager.submitIncoming(message("m1", "/twinny"));
    manager.submitIncoming(message("m2", "/banner"));

    await waitForExpect(() => expect(lark.sendCardToChatId).toHaveBeenCalledTimes(2));
    expect(lark.replyCard).not.toHaveBeenCalled();
    expect(lark.sendCardToChatId).toHaveBeenNthCalledWith(1, "oc_ignored", expect.any(Object), { uuid: expect.any(String) });
    expect(lark.sendCardToChatId).toHaveBeenNthCalledWith(2, "oc_ignored", expect.any(Object), { uuid: expect.any(String) });
    expect(JSON.stringify(vi.mocked(lark.sendCardToChatId).mock.calls[0]![1])).toContain("img_banner");
    expect(JSON.stringify(vi.mocked(lark.sendCardToChatId).mock.calls[1]![1])).toContain(
      "Twinny - Command Codex in Feishu"
    );
  });

  it("sends /banner to the source Lark thread without replying to the command message", async () => {
    const row = groupConversationRecord({ responseMode: "all", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    const lark = createLarkResponder();
    const manager = createManager({ repository, lark, assetImageKeys: { bannerImageKey: "img_banner" } });

    manager.submitIncoming(groupMessage("topic_banner", "/banner", {
      chatType: "topic_group",
      larkThreadId: "omt_topic",
      larkRootMessageId: "om_root"
    }));

    await waitForExpect(() =>
      expect(lark.replyCard).toHaveBeenCalledWith("om_root", expect.any(Object), { replyInThread: true })
    );
    expect(vi.mocked(lark.replyCard).mock.calls.map(([messageId]) => messageId)).not.toContain("topic_banner");
    expect(lark.sendCardToChatId).not.toHaveBeenCalled();
  });

  it("replies to /status with conversation, thread, and token usage", async () => {
    const row = conversationRecord({ codexThreadId: "thread_status" });
    const { repository } = createRepository(row);
    vi.mocked(repository.getCodexThreadById).mockReturnValue(codexThreadRecord({
      id: 1,
      codexThreadId: "thread_status",
      conversationKey: "p2p_ou_guest",
      profile: "guest",
      model: "gpt-5.4",
      effort: "high",
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
    expect(serialized).toContain("gpt-5.4 high");
    expect(serialized).toContain("80 (50% Cached)");
    expect(serialized).toContain("20 (25% Reasoning)");
    expect(serialized).toContain("工作区");
    expect(serialized).toContain("p2p_ou_guest");
    expect(serialized).toContain("用户");
    expect(serialized).toContain("ou_guest");
    expect(serialized).toContain("| 身份 | guest |");
    expect(serialized).not.toContain("系统");
    expect(codex.readCodexVersion).not.toHaveBeenCalled();
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
    expect(JSON.stringify(vi.mocked(lark.sendEphemeralCardToChatId).mock.calls[0]![2])).toContain("刷新");
    expect(lark.replyCard).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g_status"]);
  });

  it("hides an ephemeral /status card when its hide button is clicked", async () => {
    const row = groupConversationRecord({ responseMode: "all", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g_status", "/status"));

    await waitForExpect(() => expect(lark.sendEphemeralCardToChatId).toHaveBeenCalledTimes(1));
    const statusCard = vi.mocked(lark.sendEphemeralCardToChatId).mock.calls[0]![2] as Record<string, unknown>;
    expect(JSON.stringify(statusCard)).toContain("隐藏");

    manager.submitCardAction({
      eventId: "event_status_hide",
      operatorOpenId: "ou_guest",
      openMessageId: "ephemeral_oc_group_1",
      openChatId: "oc_group",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "status_hide",
        stateKey: "group_oc_group"
      },
      raw: { event_id: "event_status_hide" }
    });

    await waitForExpect(() => expect(lark.deleteEphemeralMessage).toHaveBeenCalledWith("ephemeral_oc_group_1"));
    expect(lark.recallMessage).not.toHaveBeenCalledWith("ephemeral_oc_group_1");
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "event_status_hide",
      routeKind: "card_action",
      status: "completed",
      text: "/status hide",
      conversationKey: "group_oc_group",
      larkGroupId: "oc_group"
    }));
  });

  it("hides a default /status card by patching it to a hidden title", async () => {
    const row = conversationRecord({ codexThreadId: "thread_status" });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(message("m1", "/status"));

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    manager.submitCardAction({
      eventId: "event_status_hide",
      operatorOpenId: "ou_guest",
      openMessageId: "card_m1_1",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "status_hide",
        stateKey: "p2p_ou_guest"
      },
      raw: { event_id: "event_status_hide" }
    });

    await waitForExpect(() => expect(lark.patchCard).toHaveBeenCalledWith("card_m1_1", expect.any(Object)));
    const patched = vi.mocked(lark.patchCard).mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(patched)).toContain("已隐藏的状态卡片");
    expect(lark.deleteEphemeralMessage).not.toHaveBeenCalled();
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "event_status_hide",
      routeKind: "card_action",
      status: "completed",
      text: "/status hide",
      conversationKey: "p2p_ou_guest"
    }));
  });

  it("refreshes a default /status card in place with latest status", async () => {
    const row = conversationRecord({ codexThreadId: "thread_status" });
    const { repository } = createRepository(row);
    vi.mocked(repository.getCodexThreadById)
      .mockReturnValueOnce(codexThreadRecord({
        codexThreadId: "thread_status",
        conversationKey: "p2p_ou_guest",
        name: "before refresh"
      }))
      .mockReturnValue(codexThreadRecord({
        codexThreadId: "thread_status",
        conversationKey: "p2p_ou_guest",
        name: "after refresh",
        model: "gpt-5.6",
        effort: "medium"
      }));
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(message("m1", "/status"));

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    manager.submitCardAction({
      eventId: "event_status_refresh",
      operatorOpenId: "ou_guest",
      openMessageId: "card_m1_1",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "status_refresh",
        stateKey: "p2p_ou_guest"
      },
      raw: { event_id: "event_status_refresh" }
    });

    await waitForExpect(() => expect(lark.patchCard).toHaveBeenCalledWith("card_m1_1", expect.any(Object)));
    const patched = vi.mocked(lark.patchCard).mock.calls[0]![1] as Record<string, unknown>;
    const serialized = JSON.stringify(patched);
    expect(serialized).toContain("after refresh");
    expect(serialized).toContain("gpt-5.6 medium");
    expect(serialized).toContain("刷新");
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "event_status_refresh",
      routeKind: "card_action",
      status: "completed",
      text: "/status refresh",
      conversationKey: "p2p_ou_guest"
    }));
  });

  it("refreshes an ephemeral /status card in place", async () => {
    const row = groupConversationRecord({ responseMode: "all", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    vi.mocked(repository.getCodexThreadById)
      .mockReturnValueOnce(codexThreadRecord({
        codexThreadId: "thread_group",
        conversationKey: "group_oc_group",
        name: "before refresh"
      }))
      .mockReturnValue(codexThreadRecord({
        codexThreadId: "thread_group",
        conversationKey: "group_oc_group",
        name: "after refresh"
      }));
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g_status", "/status"));

    await waitForExpect(() => expect(lark.sendEphemeralCardToChatId).toHaveBeenCalledTimes(1));
    manager.submitCardAction({
      eventId: "event_status_refresh",
      operatorOpenId: "ou_guest",
      openMessageId: "ephemeral_oc_group_1",
      openChatId: "oc_group",
      actionTag: "button",
      actionValue: {
        twinny: true,
        action: "status_refresh",
        stateKey: "group_oc_group"
      },
      raw: { event_id: "event_status_refresh" }
    });

    await waitForExpect(() => expect(lark.patchCard).toHaveBeenCalledWith("ephemeral_oc_group_1", expect.any(Object)));
    expect(JSON.stringify(vi.mocked(lark.patchCard).mock.calls[0]![1])).toContain("after refresh");
    expect(lark.deleteEphemeralMessage).not.toHaveBeenCalled();
  });

  it("replies to /status with a default card inside topic groups", async () => {
    const row = groupConversationRecord({ responseMode: "all", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("topic_status", "/status", {
      chatType: "topic_group",
      larkThreadId: "topic_thread",
      larkRootMessageId: "topic_root"
    }));

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    expect(lark.replyCard).toHaveBeenCalledWith(
      "topic_root",
      expect.objectContaining({ schema: "2.0" }),
      { replyInThread: true }
    );
    expect(lark.sendEphemeralCardToChatId).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["topic_status"]);
  });

  it("replies to /status inside Lark threads as a normal threaded card even when chat_type is group", async () => {
    const row = groupConversationRecord({ responseMode: "all", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("topic_status", "/status", {
      larkThreadId: "omt_topic",
      larkRootMessageId: "topic_root"
    }));

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    expect(lark.replyCard).toHaveBeenCalledWith(
      "topic_root",
      expect.objectContaining({ schema: "2.0" }),
      { replyInThread: true }
    );
    const card = vi.mocked(lark.replyCard).mock.calls[0]![1] as Record<string, unknown>;
    expect(JSON.stringify(card)).toContain("\"larkThreadId\":\"omt_topic\"");
    expect(lark.sendEphemeralCardToChatId).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["topic_status"]);
  });

  it("falls back to the command message when /status topic root metadata is missing", async () => {
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
    expect(lark.replyCard).toHaveBeenCalledWith(
      "topic_status",
      expect.objectContaining({ schema: "2.0" }),
      { replyInThread: true }
    );
    expect(lark.sendEphemeralCardToChatId).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["topic_status"]);
  });

  it("includes account usage windows in /status for the owner", async () => {
    const row = conversationRecord({
      conversationKey: "p2p_ou_owner",
      chatId: "ou_owner",
      profile: "host",
      codexThreadId: "thread_owner"
    });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, botOpenId: "ou_bot" });

    manager.submitIncoming(message("m1", "/status", { senderOpenId: "ou_owner", senderName: "Owner" }));

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    expect(codex.readCodexVersion).toHaveBeenCalledWith({ profile: "host" });
    expect(codex.readAccountRateLimits).toHaveBeenCalledWith({ profile: "host" });
    const card = vi.mocked(lark.replyCard).mock.calls[0]![1] as Record<string, unknown>;
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("p2p_ou_owner");
    expect(serialized).toContain("| 身份 | owner |");
    expect(serialized).not.toContain("| 身份 | host |");
    expect(serialized).toContain("系统");
    expect(serialized).toContain("Twinny Home");
    expect(serialized).toContain("/tmp/twinny");
    expect(serialized).toContain("Twinny 版本");
    expect(serialized).toContain("CodeX 版本");
    expect(serialized).toContain("fake-codex 1.2.3");
    expect(serialized).toContain("Lark App ID");
    expect(serialized).toContain("cli_xxx");
    expect(serialized).toContain("剩余 5h 限额");
    expect(serialized).toContain("剩余 7d 限额");
    expect(serialized).toContain("87.5%");
    expect(serialized).toContain("66%");
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
        expect.objectContaining({ profile: "guest", threadId: "thread_1", turnId: "turn_1" })
      )
    );

    expect(codex.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "guest", threadId: "thread_1", turnId: "turn_1" })
    );
    expect(lark.removeReaction).toHaveBeenCalledWith({ messageId: "m1", reactionId: "r_m1" });
    expect(lark.replyText).not.toHaveBeenCalled();

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

    await waitForExpect(() => expect(codex.clearThreadGoal).toHaveBeenCalledWith({ profile: "guest", threadId: "thread_1" }));
    expect(codex.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "guest", threadId: "thread_1", turnId: "goal_1" })
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
        expect.objectContaining({ profile: "guest", threadId: "thread_1", turnId: "turn_1" })
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
    expect(lark.replyText).not.toHaveBeenCalled();

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
    expect(lark.replyText).not.toHaveBeenCalled();

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
        profile: "guest",
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
        profile: "guest",
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

    await waitForExpect(() => expect(codex.clearThreadGoal).toHaveBeenCalledWith({ profile: "guest", threadId: "thread_1" }));
    expect(codex.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "guest", threadId: "thread_1", turnId: "goal_1" })
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
      profile: "guest",
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
    const row = groupConversationRecord({ profile: "host", responseMode: "all" });
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
      profile: "host",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never",
      developerInstructions: expect.stringContaining("Twinny Lark Context")
    });
    expect(vi.mocked(codex.startThread).mock.calls[0]![0].developerInstructions).toContain(
      "The current device owner is Owner, whose Feishu/Lark open_id is ou_owner."
    );
    expect(vi.mocked(codex.startThread).mock.calls[0]![0].developerInstructions).toContain(
      "The current Twinny conversation key is group_oc_group. The current conversation type is group_chat."
    );
    expect(vi.mocked(codex.startThread).mock.calls[0]![0].developerInstructions).not.toContain(
      "Do not modify the current thread name"
    );
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
    expect(repository.updateCodexThreadCard).toHaveBeenLastCalledWith(expect.objectContaining({
      conversationKey: "group_oc_group",
      codexThreadId: "thread_new_session",
      profile: "host",
      larkThreadId: "card_oc_group_1",
      creatorOpenId: "ou_owner",
      cardMessageId: "card_oc_group_1"
    }));
  });

  it("keeps generated Lark uuid values within the OpenAPI limit for new-session cards", async () => {
    const row = groupConversationRecord({ profile: "host", responseMode: "all" });
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
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
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
      profile: "host",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never",
      developerInstructions: expect.stringContaining("Twinny Lark Context")
    });
    expect(vi.mocked(codex.startThread).mock.calls[0]![0].developerInstructions).toContain(
      "The current Twinny conversation key is group_oc_group. The current conversation type is group_chat."
    );
    expect(vi.mocked(codex.startThread).mock.calls[0]![0].developerInstructions).not.toContain(
      "Do not modify the current thread name"
    );
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
      workspace: "/tmp/twinny/workspaces/group_oc_group",
      profile: "host",
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
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
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
        workspace: "/tmp/twinny/workspaces/group_oc_group",
        profile: "host",
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
      profile: "host",
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

  it("backfills a topic thread card before starting Codex for an untracked Lark thread", async () => {
    const row = groupConversationRecord({ profile: "host", responseMode: "all" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_backfilled" })),
      startTurn: vi.fn(async ({ threadId, onTurnStarted }) => {
        await onTurnStarted?.("turn_1");
        return completed(threadId, "turn_1");
      })
    });
    const lark = createLarkResponder();
    vi.mocked(lark.replyCard).mockResolvedValueOnce({
      messageId: "card_backfilled",
      raw: { data: { thread_id: "topic_manual" } }
    });
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage("g_manual_topic", "manual topic message", {
      chatType: "topic_group",
      larkThreadId: "topic_manual",
      larkRootMessageId: "topic_manual_root",
      senderOpenId: "ou_guest"
    }));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(lark.replyCard).toHaveBeenCalledWith("topic_manual_root", expect.any(Object), {
      replyInThread: true,
      uuid: expect.stringMatching(UUID_PATTERN)
    });
    expect(vi.mocked(lark.replyCard).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(codex.startTurn).mock.invocationCallOrder[0]!
    );
    expect(repository.updateCodexThreadCard).toHaveBeenCalledWith(expect.objectContaining({
      conversationKey: "group_oc_group",
      codexThreadId: "thread_backfilled",
      profile: "host",
      larkThreadId: "topic_manual",
      creatorOpenId: "ou_guest",
      cardMessageId: "card_backfilled"
    }));
    expect(repository.getCodexThreadByConversationAndLarkThread("group_oc_group", "topic_manual")).toMatchObject({
      codexThreadId: "thread_backfilled",
      cardMessageId: "card_backfilled"
    });
    expect(codex.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread_backfilled",
      input: wrappedMessage("manual topic message", "g_manual_topic", "ou_guest")
    }));
  });

  it("unescapes normalized post markdown when proxying /thread initial text", async () => {
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
    const { repository } = createRepository(row);
    const codex = createCodex({
      startThread: vi.fn(async () => ({ threadId: "thread_post" }))
    });
    const lark = createLarkResponder();
    const cardMessageId = "card_oc_group_1";
    vi.mocked(lark.sendCardToChatId).mockResolvedValueOnce({
      messageId: cardMessageId,
      raw: {}
    });
    vi.mocked(lark.replyText).mockResolvedValueOnce({
      messageId: "reply_thread_post_intro_1",
      raw: { data: { thread_id: "topic_thread_post" } }
    });
    vi.mocked(lark.replyPost).mockResolvedValueOnce({
      messageId: "reply_thread_post_1",
      raw: { data: { thread_id: "topic_thread_post" } }
    });
    const manager = createManager({ repository, codex, lark });

    manager.submitIncoming(groupMessage(
      "g_thread_post",
      "/thread 修复以下问题：\n\n1\\. 点击 status card 的隐藏不生效\n2\\. gpt\\-5\\.5 输出",
      {
        messageType: "post",
        senderOpenId: "ou_guest",
        senderName: "Guest User"
      }
    ));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    const proxiedPost = vi.mocked(lark.replyPost).mock.calls[0]?.[1] as Array<Array<{ text?: string }>>;
    const proxiedText = proxiedPost.flat().map((node) => node.text ?? "").join("\n");
    expect(proxiedText).toContain("1. 点击 status card 的隐藏不生效");
    expect(proxiedText).toContain("2. gpt-5.5 输出");
    expect(proxiedText).not.toContain("\\.");
    expect(proxiedText).not.toContain("\\-");
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_post",
        input: wrappedMessage(
          "修复以下问题：\n\n1\\. 点击 status card 的隐藏不生效\n2\\. gpt\\-5\\.5 输出",
          "reply_thread_post_1",
          "ou_guest"
        )
      })
    );
  });

  it("parses slash commands from /thread initial text before starting the topic turn", async () => {
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
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
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
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
      profile: "host",
      threadId: "thread_group",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never",
      developerInstructions: expect.stringContaining(
        "The current Twinny conversation key is group_oc_group. The current conversation type is group_chat."
      )
    });
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(codex.resumeThread).toHaveBeenCalledWith({
      profile: "host",
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
      profile: "host",
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
        threadId: "thread_forked"
      })
    );
    const forkInput = vi.mocked(codex.startTurn).mock.calls[0]![0].input;
    expect(forkInput).toEqual(expect.stringContaining("Fork conversation boundary."));
    expect(forkInput).toEqual(expect.stringContaining(wrappedMessage("try alternate path", "reply_fork_1", "ou_guest")));
    expect(repository.hasUserMessageForCodexThread).toHaveBeenCalledWith("thread_forked", ["reply_fork_1"]);
    expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["g_fork"]);
  });

  it("uses the default branch title for an empty /fork topic", async () => {
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
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
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
    const { repository } = createRepository(row, {
      codexThreads: [
        codexThreadRecord({
          id: 2,
          codexThreadId: "thread_topic_source",
          conversationKey: "group_oc_group",
          larkThreadId: "topic_source",
          profile: "host",
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
      profile: "host",
      threadId: "thread_topic_source",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never",
      developerInstructions: expect.stringContaining(
        "The current Twinny conversation key is group_oc_group. The current conversation type is group_chat."
      )
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
        threadId: "thread_topic_fork"
      })
    );
    const nestedForkInput = vi.mocked(codex.startTurn).mock.calls[0]![0].input;
    expect(nestedForkInput).toEqual(expect.stringContaining("Fork conversation boundary."));
    expect(nestedForkInput).toEqual(expect.stringContaining(wrappedMessage("nested work", "reply_topic_fork_1", "ou_guest")));
  });

  it("runs /side as an ephemeral default-mode turn with a numbered temporary card", async () => {
    const sideTurn = deferred<CodexTurnResult>();
    let sideParams: Parameters<CodexBridge["startTurn"]>[0] | undefined;
    const { repository } = createRepository(conversationRecord(), {
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_1",
          conversationKey: "p2p_ou_guest",
          profile: "guest",
          mode: "plan"
        })
      ]
    });
    const codex = createCodex({
      forkThread: vi.fn(async () => ({ threadId: "thread_1_side_1" })),
      startTurn: vi.fn((params) => {
        sideParams = params;
        void params.onTurnStarted?.("side_turn_1");
        return sideTurn.promise;
      })
    });
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m_side", "/side /plan inspect this"));

    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));
    expect(codex.forkThread).toHaveBeenCalledWith({
      profile: "guest",
      threadId: "thread_1",
      cwd: "/tmp/twinny/workspaces/p2p_ou_guest",
      approvalPolicy: "never",
      ephemeral: true,
      developerInstructions: expect.stringContaining("You are in a side conversation"),
      model: "gpt-5.5",
      effort: "medium"
    });
    expect(vi.mocked(codex.forkThread).mock.calls[0]![0].developerInstructions).toContain(
      "The current Twinny conversation key is p2p_ou_guest. The current conversation type is p2p."
    );
    expect(codex.injectThreadItems).toHaveBeenCalledWith({
      profile: "guest",
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
        profile: "guest",
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
      workspace: "/tmp/twinny/workspaces/p2p_ou_guest",
      profile: "guest",
      model: "gpt-5.5",
      effort: "medium",
      category: "side"
    });
    const rawUsage = {
      threadId: "thread_1_side_1",
      turnId: "side_turn_1",
      tokenUsage: {
        total: {
          totalTokens: 18,
          inputTokens: 15,
          cachedInputTokens: 5,
          outputTokens: 3,
          reasoningOutputTokens: 1
        }
      }
    };
    await sideParams?.onTokenUsage?.({
      threadId: "thread_1_side_1",
      turnId: "side_turn_1",
      totalTokens: 18,
      raw: rawUsage
    });
    expect(repository.updateLarkMessageTokenUsage).toHaveBeenCalledWith({
      larkMessageId: "m_side",
      inputTokens: 15,
      outputTokens: 3,
      cachedInputTokens: 5,
      reasoningOutputTokens: 1,
      tokenUsageJson: JSON.stringify(rawUsage)
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
      profile: "guest",
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
      profile: "guest",
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
        profile: "guest",
        threadId: "thread_1_side",
        turnId: "turn_2"
      }))
    );
    expect(codex.interruptTurn).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread_1", turnId: "turn_1" })
    );
    expect(repository.markLarkMessagesInterrupted).toHaveBeenCalledWith(["m_side"]);
    expect(repository.markLarkMessagesInterrupted).not.toHaveBeenCalledWith(["m_main"]);
    expect(lark.replyText).not.toHaveBeenCalled();

    turns[1]!.resolve(completed("thread_1_side", "turn_2", "interrupted"));
    turns[0]!.resolve(completed("thread_1", "turn_1"));
  });

  it("stops every running side turn on /stop all", async () => {
    const { repository } = createRepository(groupConversationRecord({ profile: "guest" }));
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
      expect.objectContaining({ profile: "guest", threadId: "thread_group_side_1", turnId: "turn_1" })
    );
    expect(codex.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "guest", threadId: "thread_group_side_2", turnId: "turn_2" })
    );
    expect(repository.markLarkMessagesInterrupted).toHaveBeenCalledWith(["g_side_1"]);
    expect(repository.markLarkMessagesInterrupted).toHaveBeenCalledWith(["g_side_2"]);
    expect(lark.replyText).not.toHaveBeenCalled();

    turns[0]!.resolve(completed("thread_group_side_1", "turn_1", "interrupted"));
    turns[1]!.resolve(completed("thread_group_side_2", "turn_2", "interrupted"));
  });

  it("rejects /side nested under /thread or /fork", async () => {
    const { repository } = createRepository(groupConversationRecord({ profile: "host" }));
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
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
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
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
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
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
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
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
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
    vi.mocked(lark.sendCardToOpenId).mockResolvedValueOnce({
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
    expect(lark.sendCardToOpenId).toHaveBeenCalledWith("ou_guest", expect.any(Object), {
      uuid: expect.stringMatching(UUID_PATTERN)
    });
    expect(vi.mocked(lark.replyCard).mock.calls.some(([messageId]) => messageId === "m_thread")).toBe(false);
    expect(lark.replyText).toHaveBeenNthCalledWith(
      1,
      "card_dm_thread_1",
      '话题由 <at user_id="ou_guest">Guest User</at> 创建',
      { replyInThread: true }
    );
    expect(lark.replyText).toHaveBeenNthCalledWith(2, "card_dm_thread_1", "hello", { replyInThread: true });
    expect(lark.sendCardToChatId).not.toHaveBeenCalled();
    expect(lark.recallMessage).toHaveBeenCalledWith("card_reply_dm_thread_1_1");
    expect(repository.updateCodexThreadCard).toHaveBeenLastCalledWith(expect.objectContaining({
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_dm_topic",
      profile: "guest",
      name: "hello",
      larkThreadId: "dm_thread_1",
      creatorOpenId: "ou_guest",
      cardMessageId: "card_dm_thread_1"
    }));
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
      expect.objectContaining({ profile: "guest", threadId: "thread_old", turnId: "turn_1" })
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

    manager.submitIncoming(groupMessage("g1", "/activate all_at guest", { senderOpenId: "ou_owner", senderName: "Owner" }));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith(
        "g1",
        expect.stringContaining("已激活群聊：Team Room\n响应模式：all_at\nProfile：guest")
      )
    );
    expect(row).toBeUndefined();
    expect(repository.findByConversationKey("group_oc_group")).toBeDefined();
    expect(codex.startThread).toHaveBeenCalledWith({
      profile: "guest",
      cwd: "/tmp/twinny/workspaces/group_oc_group",
      approvalPolicy: "never",
      developerInstructions: expect.stringContaining("Do not modify the current thread name")
    });
    expect(vi.mocked(codex.startThread).mock.calls[0]![0].developerInstructions).toContain(
      "Do not disclose private information to non-owner users."
    );
    expect(vi.mocked(codex.startThread).mock.calls[0]![0].developerInstructions).toContain(
      "The current Twinny conversation key is group_oc_group. The current conversation type is group_chat."
    );
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "g1",
        larkGroupId: "oc_group",
        conversationKey: "group_oc_group",
        routeKind: "control_message",
        text: "/activate all_at guest"
      })
    );
    expect(repository.findByConversationKey("group_oc_group")).toMatchObject({
      conversationKey: "group_oc_group",
      type: "group",
      chatId: "oc_group",
      name: "Team Room",
      responseMode: "all_at",
      profile: "guest",
      workspace: "/tmp/twinny/workspaces/group_oc_group"
    });
  });

  it("adds non-at group message configuration hints without blocking /activate", async () => {
    const { repository } = createRepository();
    const codex = createCodex();
    const lark = createLarkResponder();
    const larkChats: LarkChatDirectory = {
      getChatInfo: vi.fn(async () => ({ name: "Team Room", chatMode: "group" as const }))
    };
    const larkFeatureConfig: LarkFeatureConfigurationStatusProvider = {
      checkFeatureSet: vi.fn(async () => missingFeatureResult("group_non_at", "群聊非 at 消息", {
        missingScopes: ["im:message.group_msg"],
        scopeApplyUrl: "https://open.larkoffice.com/page/scope-apply?clientID=cli_xxx&scopes=im%3Amessage.group_msg"
      }))
    };
    const manager = createManager({ repository, codex, lark, larkChats, larkFeatureConfig, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g1", "/activate all guest", { senderOpenId: "ou_owner", senderName: "Owner" }));

    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith(
        "g1",
        expect.stringContaining("已激活群聊：Team Room\n响应模式：all\nProfile：guest")
      )
    );
    expect(lark.replyText).toHaveBeenCalledWith(
      "g1",
      expect.stringContaining("否则 bot 无法收到非 at 群消息")
    );
    expect(repository.findByConversationKey("group_oc_group")).toBeDefined();
    expect(larkFeatureConfig.checkFeatureSet).toHaveBeenCalledWith("group_non_at");
  });

  it("keeps a group's first activated profile immutable while allowing mode and name refreshes", async () => {
    const { repository } = createRepository();
    const lark = createLarkResponder();
    const larkChats: LarkChatDirectory = {
      getChatInfo: vi.fn()
        .mockResolvedValueOnce({ name: "Owner Room", chatMode: "topic" as const })
        .mockResolvedValueOnce({ name: "Renamed Room", chatMode: "group" as const })
    };
    const manager = createManager({ repository, lark, larkChats, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g1", "/activate all host", { senderOpenId: "ou_owner", senderName: "Owner" }));
    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith(
        "g1",
        expect.stringContaining("已激活群聊：Owner Room\n响应模式：all\nProfile：host")
      )
    );
    expect(repository.findByConversationKey("group_oc_group")).toMatchObject({
      name: "Owner Room",
      responseMode: "all",
      profile: "host"
    });

    manager.submitIncoming(groupMessage("g2", "/activate all_at", { senderOpenId: "ou_owner", senderName: "Owner" }));
    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith(
        "g2",
        expect.stringContaining("已激活群聊：Renamed Room\n响应模式：all_at\nProfile：host")
      )
    );
    expect(repository.findByConversationKey("group_oc_group")).toMatchObject({
      name: "Renamed Room",
      responseMode: "all_at",
      profile: "host"
    });

    manager.submitIncoming(
      groupMessage("g3", "@_bot /activate all guest", {
        senderOpenId: "ou_owner",
        senderName: "Owner",
        mentions: [botMention()]
      })
    );
    await waitForExpect(() =>
      expect(lark.replyText).toHaveBeenCalledWith("g3", "该群已绑定 profile=host，本期不支持修改为 guest。")
    );
    expect(repository.findByConversationKey("group_oc_group")).toMatchObject({
      responseMode: "all_at",
      profile: "host"
    });
  });

  it("requires bot mentions in at-mode groups and strips the mention before parsing commands", async () => {
    const row = groupConversationRecord({ responseMode: "all_at" });
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
    expect(JSON.stringify(vi.mocked(lark.sendEphemeralCardToChatId).mock.calls[0]![2])).toContain("全部用户，at 消息");
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
      groupMessage("g4", "@Alice @Twinny /status", {
        mentions: [
          { key: "@_alice", openId: "ou_alice", name: "Alice" },
          botMention()
        ]
      })
    );
    await waitForExpect(() => expect(lark.sendEphemeralCardToChatId).toHaveBeenCalledTimes(2));
    expect(repository.insertLarkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        larkMessageId: "g4",
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
    await waitForExpect(() => expect(lark.replyText).toHaveBeenCalledWith("g3", expect.stringContaining("/activate <owner_at|owner|all_at|all> [profile]")));
    expect(lark.replyText).toHaveBeenCalledWith("g3", expect.stringContaining("/deactivate -"));
  });

  it("uses the shared group profile and workspace for all-mode ordinary group messages", async () => {
    const row = groupConversationRecord({ responseMode: "all", profile: "host", codexThreadId: "thread_group" });
    const { repository } = createRepository(row);
    const codex = createCodex();
    const manager = createManager({ repository, codex, botOpenId: "ou_bot" });

    manager.submitIncoming(groupMessage("g1", "hello group"));

    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    expect(codex.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "host", threadId: "thread_group", cwd: "/tmp/twinny/workspaces/group_oc_group" })
    );
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "host",
        threadId: "thread_group",
        cwd: "/tmp/twinny/workspaces/group_oc_group",
        input: '<lark_message lark_message_id="g1" timestamp="1234" sender_ouid="ou_guest" sender_name="Guest User">\nhello group\n</lark_message>'
      })
    );
  });

  it("ignores unmentioned at-mode topic messages and still reuses thread on the next mention", async () => {
    const row = groupConversationRecord({ profile: "host", responseMode: "all_at" });
    const { repository } = createRepository(row);
    const thread = codexThreadRecord({
      codexThreadId: "thread_topic_1",
      larkThreadId: "topic_thread_1",
      conversationKey: "group_oc_group",
      profile: "host",
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
      profile: "host",
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
        expect.stringContaining("已激活群聊：Reenabled Room\n响应模式：all\nProfile：guest")
      )
    );
    expect(row).toMatchObject({ name: "Reenabled Room", responseMode: "all", profile: "guest" });
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
      expect.objectContaining({ profile: "guest", threadId: "thread_group", turnId: "turn_1" })
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
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_token",
      threadId: "thread_missing",
      watchMode: "owner",
      watchUrl: "https://example.feishu.cn/docx/doc_token"
    });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyMarkdown).toHaveBeenCalledWith("m1", "reply"));

    expect(row.codexThreadId).toBe("thread_replacement");
    expect(repository.listLarkDocWatchersByThread("thread_missing")).toEqual([]);
    expect(repository.listLarkDocWatchersByThread("thread_replacement")).toEqual([
      expect.objectContaining({
        fileType: "docx",
        fileToken: "doc_token",
        threadId: "thread_replacement"
      })
    ]);
    expect(repository.migrateLarkDocWatchersToThread).toHaveBeenCalledWith("thread_missing", "thread_replacement");
    expect(codex.startTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread_replacement" }));
    expect(lark.replyText).toHaveBeenNthCalledWith(
      1,
      "m1",
      "警告：Codex thread 状态缺失。Twinny 已为当前会话创建替代 thread，之前的上下文已不可用。"
    );
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
    repository.upsertLarkDocWatcher({
      fileType: "docx",
      fileToken: "doc_turn",
      threadId: "thread_missing",
      watchMode: "all",
      watchUrl: "https://example.feishu.cn/docx/doc_turn"
    });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyMarkdown).toHaveBeenCalledWith("m1", "reply"));

    expect(row.codexThreadId).toBe("thread_replacement");
    expect(repository.listLarkDocWatchersByThread("thread_missing")).toEqual([]);
    expect(repository.listLarkDocWatchersByThread("thread_replacement")).toEqual([
      expect.objectContaining({
        fileType: "docx",
        fileToken: "doc_turn",
        threadId: "thread_replacement"
      })
    ]);
    expect(repository.migrateLarkDocWatchersToThread).toHaveBeenCalledWith("thread_missing", "thread_replacement");
    expect(codex.resumeThread).not.toHaveBeenCalled();
    expect(codex.startTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({ threadId: "thread_missing" }));
    expect(codex.startTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ threadId: "thread_replacement" }));
    expect(repository.getCodexThreadById("thread_replacement")).toMatchObject({ codexThreadHasRollout: true });
    expect(repository.markLarkMessagesFailed).not.toHaveBeenCalled();
    expect(lark.replyText).toHaveBeenNthCalledWith(
      1,
      "m1",
      "警告：Codex thread 状态缺失。Twinny 已为当前会话创建替代 thread，之前的上下文已不可用。"
    );
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

  it("renders retryable Codex errors in the working process and captures telemetry", async () => {
    const telemetry = createTelemetry();
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ codex, lark, telemetry, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await turns[0]!.params.onCodexError?.({
      threadId: "thread_1",
      turnId: "turn_1",
      message: "Reconnecting... 2/5",
      willRetry: true,
      codexErrorInfo: "responseStreamDisconnected",
      additionalDetails: "request timed out",
      raw: {}
    });

    await waitForExpect(() => {
      const patched = vi.mocked(lark.patchCard).mock.calls.find(([, card]) =>
        JSON.stringify(card).includes("[Codex ERROR] Reconnecting... 2/5")
      )?.[1];
      expect(JSON.stringify(patched)).toContain("willRetry=true");
      expect(JSON.stringify(patched)).toContain("responseStreamDisconnected");
      expect(JSON.stringify(patched)).toContain("request timed out");
    });

    const event = capturedTelemetryEvents(telemetry, "twinny_codex_error")[0]!;
    expect(event.properties).toMatchObject({
      conversation_id: "hashed:conversation:12",
      thread_id: "hashed:codex_thread:8",
      turn_id: "hashed:codex_turn:6",
      status: "working",
      turn_type: "default",
      turn_operation: "normal",
      will_retry: true,
      codex_error_info: "responseStreamDisconnected",
      codex_error_message_hash: "hashed:codex_error_message:19",
      codex_error_message_length: 19,
      codex_error_additional_details_hash: "hashed:codex_error_additional_details:17",
      codex_error_additional_details_length: 17
    });
    expect(JSON.stringify(event)).not.toContain("Reconnecting... 2/5");

    turns[0]!.resolve(completed("thread_1", "turn_1"));
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

    await goals[0]!.params.onGoalUpdated?.({
      threadId: "thread_1",
      objective: "finish the target",
      status: "blocked",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 2
    }, "goal_1");
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
    await waitForExpect(() => expect(codex.clearThreadGoal).toHaveBeenCalledWith({ profile: "guest", threadId: "thread_1" }));
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
    await waitForExpect(() => expect(codex.clearThreadGoal).toHaveBeenCalledWith({ profile: "guest", threadId: "thread_1" }));
    expect(vi.mocked(codex.clearThreadGoal!).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(lark.replyCard).mock.invocationCallOrder[1]!
    );
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
        profile: "guest",
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
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-profile-config-"));
    const codexHome = path.join(tempRoot, "codex");
    fs.mkdirSync(codexHome, { recursive: true });
    const managerConfig: TwinnyConfig = {
      ...cardModeConfig(),
      profiles: {
        ...config.profiles,
        guest: { codexHome, defaultModel: "gpt-5.5", defaultEffort: "xhigh" }
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

  it("updates the completed card in place when there are no valid turn participants to mention", async () => {
    const { repository } = createRepository(groupConversationRecord());
    const { codex, turns } = createDeferredCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(groupMessage("m1", "first", { senderOpenId: "", senderName: "" }));
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    turns[0]!.resolve(completed("thread_group", "turn_1"));
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

    const completedCard = vi.mocked(lark.patchCard).mock.calls.find(([messageId]) => messageId === "card_m1_1")?.[1];
    const completedBodyElements = ((completedCard as Record<string, unknown>).body as { elements: unknown[] }).elements;
    expect(JSON.stringify(completedBodyElements[0])).not.toContain("<at id=");
    expect(lark.getMessageReadOpenIds).not.toHaveBeenCalled();
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
    const manager = createManager({
      codex,
      lark,
      config: cardModeConfig(),
      assetImageKeys: { logoImageKey: "img_logo" }
    });

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
      config: cardModeConfig(),
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
      config: cardModeConfig(),
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
          text: "checking <mention_lark_user>ou_noise</mention_lark_user>",
          phase: "commentary"
        });
        await onAgentMessage?.({
          id: "agent_2",
          text: "请看 <mention_lark_user>ou_target</mention_lark_user>",
          phase: "final_answer"
        });
        return {
          threadId,
          turnId: "turn_1",
          text: "checking <mention_lark_user>ou_noise</mention_lark_user>\n\n请看 <mention_lark_user>ou_target</mention_lark_user>",
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
    expect(serialized).not.toContain("<mention_lark_user>ou_target</mention_lark_user>");
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
          text: "checking <mention_lark_user>ou_noise</mention_lark_user>",
          phase: "commentary"
        });
        await onAgentMessage?.({
          id: "agent_2",
          text: "hi <mention_lark_user>ou_target</mention_lark_user> please",
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
      "checking <mention_lark_user>ou_noise</mention_lark_user>"
    );
    expect(lark.replyPost).toHaveBeenCalledWith("m1", [
      [
        { tag: "md", text: "hi " },
        { tag: "at", user_id: "ou_target" },
        { tag: "md", text: " please" }
      ]
    ]);
  });

  it("does not render Codex Lark mention tags inside markdown code in final card output", async () => {
    const finalText = [
      "Ping <mention-lark-user>ou_target</mention-lark-user>",
      "Use `<mention-lark-user>ou_inline</mention-lark-user>` as an example.",
      "```",
      "<mention-lark-user>ou_block</mention-lark-user>",
      "```"
    ].join("\n");
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({
          id: "agent_1",
          text: finalText,
          phase: "final_answer"
        });
        return {
          threadId,
          turnId: "turn_1",
          text: finalText,
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
    expect(serialized).toContain("<mention-lark-user>ou_inline</mention-lark-user>");
    expect(serialized).toContain("<mention-lark-user>ou_block</mention-lark-user>");
    expect(serialized).toContain("<at id=ou_target></at>");
    expect(serialized).not.toContain("<at id=ou_inline></at>");
    expect(serialized).not.toContain("<at id=ou_block></at>");
    expect(finalCard.config).toMatchObject({
      summary: { content: expect.stringContaining("@ou_target") }
    });
  });

  it("keeps Codex Lark mention tags inside markdown code in fallback plain final_answer messages", async () => {
    const finalText = [
      "```",
      "<mention-lark-user>ou_block</mention-lark-user>",
      "```",
      "`<mention-lark-user>ou_inline</mention-lark-user>`"
    ].join("\n");
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({
          id: "agent_1",
          text: finalText,
          phase: "final_answer"
        });
        return completed(threadId, "turn_1");
      })
    });
    const lark = createLarkResponder();
    vi.mocked(lark.replyCard).mockRejectedValue(new Error("card unavailable"));
    const manager = createManager({ codex, lark });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyMarkdown).toHaveBeenCalledWith("m1", finalText));

    expect(lark.replyPost).not.toHaveBeenCalled();
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
        expect.objectContaining({ profile: "guest", threadId: "thread_1", turnId: "turn_1" })
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
        expect.objectContaining({ profile: "guest", threadId: "thread_1", turnId: "turn_1" })
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
        expect.objectContaining({ profile: "guest", threadId: "thread_1", turnId: "turn_1" })
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
        expect.objectContaining({ profile: "guest", threadId: "thread_group", turnId: "turn_1" })
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

  it("runs a same-user /exit directly while plan waiting without queued reactions", async () => {
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
        expect.objectContaining({ profile: "guest", threadId: "thread_group", turnId: "turn_1" })
      )
    );
    await waitForExpect(() => {
      const inserted = vi.mocked(repository.insertLarkMessage).mock.calls.map(([input]) => input);
      expect(inserted.find((input) => input.larkMessageId === "g2")).toMatchObject({
        routeKind: "control_message",
        status: "processing",
        text: "/exit"
      });
    });
    expect(lark.addQueuedReaction).not.toHaveBeenCalled();
    expect(manager.queueDepth("group_oc_group")).toBe(0);

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
    manager.submitIncoming(groupMessage("g2", "/queue different-user queued", { senderOpenId: "ou_other" }));
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
        expect.objectContaining({ profile: "guest", threadId: "thread_group", turnId: "turn_1" })
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

  it("ignores SEND_TO_LARK directives inside markdown code in fallback plain replies", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-send-code-"));
    const workspaceRoot = path.join(tempRoot, "workspaces");
    const workspace = path.join(workspaceRoot, "p2p_ou_guest");
    fs.mkdirSync(workspace, { recursive: true });
    const imagePath = path.join(workspace, "result.png");
    fs.writeFileSync(imagePath, "png");
    const finalText = [
      "ready",
      "```",
      `SEND_TO_LARK: <img path="${imagePath}"></img>`,
      "```",
      "`inline",
      `SEND_TO_LARK: <img path="${imagePath}"></img>`,
      "`",
      "done"
    ].join("\n");
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onAgentMessage }) => {
        await onTurnStarted?.("turn_1");
        await onAgentMessage?.({
          id: "agent_1",
          text: finalText
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
    await waitForExpect(() => expect(lark.replyMarkdown).toHaveBeenCalledWith("m1", finalText));

    expect(larkFiles.uploadImage).not.toHaveBeenCalled();
    expect(lark.replyPost).not.toHaveBeenCalled();
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

  it("continues recovered turn usage on the original start message", async () => {
    const row = conversationRecord({ codexThreadId: "thread_recovered" });
    const startRecord = larkMessageRecord({
      larkMessageId: "m_start",
      eventId: "e_m_start",
      codexThreadId: "thread_recovered",
      codexTurnId: "turn_1",
      routeKind: "message",
      status: "steered",
      inputTokens: 10,
      outputTokens: 3,
      cachedInputTokens: 4,
      reasoningOutputTokens: 1,
      tokenUsageJson: '{"previous":true}',
      rawEventJson: JSON.stringify(rawReceiveEvent("m_start", "start"))
    });
    const steerRecord = larkMessageRecord({
      larkMessageId: "m_steer",
      eventId: "e_m_steer",
      codexThreadId: "thread_recovered",
      codexTurnId: "turn_1",
      routeKind: "steered_message",
      status: "processing",
      rawEventJson: JSON.stringify(rawReceiveEvent("m_steer", "steer"))
    });
    const { repository } = createRepository(row, {
      larkMessages: [startRecord, steerRecord],
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_recovered",
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 40,
          reasoningOutputTokens: 5,
          totalTokens: 120,
          tokenUsageJson: JSON.stringify({
            tokenUsage: {
              total: {
                totalTokens: 120,
                inputTokens: 100,
                cachedInputTokens: 40,
                outputTokens: 20,
                reasoningOutputTokens: 5
              }
            }
          })
        })
      ]
    });
    const raw = {
      threadId: "thread_recovered",
      turnId: "turn_1",
      tokenUsage: {
        total: {
          totalTokens: 147,
          inputTokens: 125,
          cachedInputTokens: 50,
          outputTokens: 22,
          reasoningOutputTokens: 7
        }
      }
    };
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onTokenUsage }) => {
        await onTurnStarted?.("turn_1");
        await onTokenUsage?.({ threadId, turnId: "turn_1", totalTokens: 147, raw });
        return completed(threadId, "turn_1");
      })
    });
    const manager = createManager({ repository, codex });

    await manager.recoverUnfinishedMessages();
    await waitForExpect(() => expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m_steer"]));

    expect(repository.updateLarkMessageTokenUsage).toHaveBeenCalledWith({
      larkMessageId: "m_start",
      inputTokens: 35,
      outputTokens: 5,
      cachedInputTokens: 14,
      reasoningOutputTokens: 3,
      tokenUsageJson: JSON.stringify(raw)
    });
    expect(vi.mocked(repository.updateLarkMessageTokenUsage).mock.calls.some(([input]) => input.larkMessageId === "m_steer")).toBe(false);
  });

  it("falls back to the latest steer message when a recovered usage target is missing", async () => {
    const row = conversationRecord({ codexThreadId: "thread_recovered" });
    const steerRecord = larkMessageRecord({
      larkMessageId: "m_steer",
      eventId: "e_m_steer",
      codexThreadId: "thread_recovered",
      codexTurnId: "turn_1",
      routeKind: "steered_message",
      status: "processing",
      inputTokens: 2,
      outputTokens: 1,
      cachedInputTokens: 1,
      reasoningOutputTokens: 0,
      rawEventJson: JSON.stringify(rawReceiveEvent("m_steer", "steer"))
    });
    const { repository } = createRepository(row, {
      larkMessages: [steerRecord],
      codexThreads: [
        codexThreadRecord({
          codexThreadId: "thread_recovered",
          inputTokens: 10,
          outputTokens: 4,
          cachedInputTokens: 2,
          reasoningOutputTokens: 1,
          totalTokens: 14,
          tokenUsageJson: JSON.stringify({
            tokenUsage: {
              total: {
                totalTokens: 14,
                inputTokens: 10,
                cachedInputTokens: 2,
                outputTokens: 4,
                reasoningOutputTokens: 1
              }
            }
          })
        })
      ]
    });
    const raw = {
      threadId: "thread_recovered",
      turnId: "turn_1",
      tokenUsage: {
        total: {
          totalTokens: 20,
          inputTokens: 15,
          cachedInputTokens: 4,
          outputTokens: 5,
          reasoningOutputTokens: 2
        }
      }
    };
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted, onTokenUsage }) => {
        await onTurnStarted?.("turn_1");
        await onTokenUsage?.({ threadId, turnId: "turn_1", totalTokens: 20, raw });
        return completed(threadId, "turn_1");
      })
    });
    const logger = createLogger();
    const manager = createManager({ repository, codex, logger });

    await manager.recoverUnfinishedMessages();
    await waitForExpect(() => expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m_steer"]));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ codexThreadId: "thread_recovered", codexTurnId: "turn_1" }),
      "failed to find lark message usage target while recovering turn; trying latest steer message"
    );
    expect(repository.updateCodexThreadTokenUsage).toHaveBeenCalledWith(expect.objectContaining({
      codexThreadId: "thread_recovered",
      inputTokens: 15,
      outputTokens: 5
    }));
    expect(repository.updateLarkMessageTokenUsage).toHaveBeenCalledWith({
      larkMessageId: "m_steer",
      inputTokens: 7,
      outputTokens: 2,
      cachedInputTokens: 3,
      reasoningOutputTokens: 1,
      tokenUsageJson: JSON.stringify(raw)
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
          profile: "guest",
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
      profile: "guest",
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
        profile: "guest",
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

  it("recovers only unfinished messages for the selected profile", async () => {
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
          profile: "guest"
        }),
        codexThreadRecord({
          id: 2,
          codexThreadId: "thread_owner",
          conversationKey: "p2p_ou_owner",
          profile: "host"
        })
      ]
    });
    const codex = createCodex();
    const manager = createManager({ repository, codex });

    await manager.recoverUnfinishedMessages({ profile: "host" });
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    expect(codex.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ profile: "host", threadId: "thread_owner" }));
    expect(codex.resumeThread).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread_guest" }));
    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "host",
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

  it("recovers queued doc comments with refresh and terminal document reply", async () => {
    const row = conversationRecord({ codexThreadId: "thread_recovered" });
    const record = larkMessageRecord({
      larkMessageId: "proxy_doc_comment",
      eventId: "doc_comment:event_doc_comment:docx:doc_token",
      larkUserId: "ou_owner",
      routeKind: "doc_comment",
      status: "queued",
      text: "stale doc comment",
      codexThreadId: "thread_recovered",
      rawEventJson: JSON.stringify({
        kind: "doc_comment",
        file_type: "docx",
        file_token: "doc_token",
        comment_id: "comment_1",
        reply_id: "reply_1",
        is_whole: true,
        watch_url: "https://example.feishu.cn/docx/doc_token"
      })
    });
    const { repository } = createRepository(row, { larkMessages: [record] });
    const larkDocComments = createLarkDocCommentClient(larkDocCommentSnapshot({
      text: "Updated doc comment",
      isWhole: true
    }));
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted }) => {
        await onTurnStarted?.("turn_1");
        return { ...completed(threadId, "turn_1"), text: "Recovered final" };
      })
    });
    const manager = createManager({ repository, codex, larkDocComments });

    await manager.recoverUnfinishedMessages();
    await waitForExpect(() => expect(codex.startTurn).toHaveBeenCalledTimes(1));

    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_recovered",
        input: expect.stringContaining("Updated doc comment")
      })
    );
    expect(repository.updateQueuedLarkMessage).toHaveBeenCalledWith(
      "proxy_doc_comment",
      expect.objectContaining({
        text: expect.stringContaining("Updated doc comment")
      })
    );
    await waitForExpect(() =>
      expect(larkDocComments.replyToComment).toHaveBeenCalledWith({
        fileType: "docx",
        fileToken: "doc_token",
        commentId: "comment_1",
        isWhole: true,
        text: "Recovered final"
      })
    );
  });

  it("recovers processing doc comments and replies terminal output to the document", async () => {
    const row = conversationRecord({ codexThreadId: "thread_recovered" });
    const record = larkMessageRecord({
      larkMessageId: "proxy_doc_comment",
      eventId: "doc_comment:event_doc_comment:docx:doc_token",
      larkUserId: "ou_owner",
      routeKind: "doc_comment",
      status: "processing",
      text: "processing doc comment",
      codexThreadId: "thread_recovered",
      rawEventJson: JSON.stringify({
        kind: "doc_comment",
        file_type: "docx",
        file_token: "doc_token",
        comment_id: "comment_1",
        reply_id: "reply_1",
        is_whole: false,
        watch_url: "https://example.feishu.cn/docx/doc_token"
      })
    });
    const { repository } = createRepository(row, { larkMessages: [record] });
    const larkDocComments = createLarkDocCommentClient();
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted }) => {
        await onTurnStarted?.("turn_1");
        return { ...completed(threadId, "turn_1"), text: "Recovered doc final" };
      })
    });
    const manager = createManager({ repository, codex, larkDocComments });

    await manager.recoverUnfinishedMessages();
    await waitForExpect(() => expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["proxy_doc_comment"]));

    expect(codex.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_recovered",
        input: "Twinny daemon has beed reloaded, continue with the unfinished work."
      })
    );
    await waitForExpect(() =>
      expect(larkDocComments.replyToComment).toHaveBeenCalledWith({
        fileType: "docx",
        fileToken: "doc_token",
        commentId: "comment_1",
        isWhole: false,
        text: "Recovered doc final"
      })
    );
  });

  it("recovers contiguous steered doc comments before processing messages for terminal document replies", async () => {
    const row = conversationRecord({ codexThreadId: "thread_recovered" });
    const docCommentRecord = larkMessageRecord({
      id: 1,
      larkMessageId: "proxy_doc_comment",
      eventId: "doc_comment:event_doc_comment:docx:doc_token",
      larkUserId: "ou_owner",
      routeKind: "doc_comment_reply_steer",
      status: "steered",
      text: "steered doc comment",
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_recovered",
      codexTurnId: "turn_1",
      receivedAt: 100,
      rawEventJson: JSON.stringify({
        kind: "doc_comment",
        file_type: "docx",
        file_token: "doc_token",
        comment_id: "comment_1",
        reply_id: "reply_1",
        is_whole: false,
        watch_url: "https://example.feishu.cn/docx/doc_token"
      })
    });
    const steerRecord = larkMessageRecord({
      id: 2,
      larkMessageId: "m_steer",
      eventId: "e_m_steer",
      larkUserId: "ou_owner",
      routeKind: "steered_message",
      status: "processing",
      text: "extra context",
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_recovered",
      codexTurnId: "turn_1",
      receivedAt: 110,
      rawEventJson: JSON.stringify(rawReceiveEvent("m_steer", "extra context", { senderOpenId: "ou_owner" }))
    });
    const { repository } = createRepository(row, { larkMessages: [docCommentRecord, steerRecord] });
    const larkDocComments = createLarkDocCommentClient();
    const codex = createCodex({
      startTurn: vi.fn(async ({ threadId, onTurnStarted }) => {
        await onTurnStarted?.("turn_1");
        return { ...completed(threadId, "turn_1"), text: "Recovered final after steer" };
      })
    });
    const manager = createManager({ repository, codex, larkDocComments });

    await manager.recoverUnfinishedMessages();
    await waitForExpect(() => expect(repository.markLarkMessagesCompleted).toHaveBeenCalledWith(["m_steer"]));

    expect(repository.getLarkMessageById("proxy_doc_comment")).toMatchObject({ status: "steered" });
    expect(repository.markLarkMessagesProcessing).not.toHaveBeenCalledWith(
      ["proxy_doc_comment"],
      expect.anything()
    );
    await waitForExpect(() =>
      expect(larkDocComments.replyToComment).toHaveBeenCalledWith({
        fileType: "docx",
        fileToken: "doc_token",
        commentId: "comment_1",
        isWhole: false,
        text: "Recovered final after steer"
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
        profile: "guest"
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
        profile: "guest"
      })
    );
  });

  it("fails unreplayable processing control messages during startup recovery", async () => {
    const record = larkMessageRecord({
      larkMessageId: "m_reload",
      eventId: "e_m_reload",
      larkUserId: "ou_owner",
      conversationKey: "p2p_ou_owner",
      routeKind: "control_message",
      status: "processing",
      text: "/reload",
      rawEventJson: JSON.stringify({
        ...rawReceiveEvent("m_reload", "/reload"),
        sender: {
          sender_id: { open_id: "ou_owner" },
          sender_type: "user"
        }
      })
    });
    const { repository } = createRepository(undefined, { larkMessages: [record] });
    const codex = createCodex();
    const lark = createLarkResponder();
    const manager = createManager({ repository, codex, lark });

    await manager.recoverUnfinishedMessages();

    expect(codex.resumeThread).not.toHaveBeenCalled();
    expect(codex.startTurn).not.toHaveBeenCalled();
    expect(repository.markLarkMessagesFailed).toHaveBeenCalledWith(["m_reload"]);
    expect(repository.markLarkMessagesProcessing).not.toHaveBeenCalledWith(["m_reload"], expect.anything());
    const recovered = repository.getLarkMessageById("m_reload") as LarkMessageRecord | undefined;
    expect(recovered).toMatchObject({ status: "failed" });
    expect(recovered?.codexTurnId).toBeUndefined();
    expect(lark.replyText).toHaveBeenCalledWith(
      "m_reload",
      "上一条控制命令在 Twinny daemon 重启前中断，已终止；请重新执行。"
    );
  });

  it("recovers processing thread replies from persisted DB fields when raw event JSON is missing", async () => {
    const row = groupConversationRecord({ profile: "host", codexThreadId: "thread_recovered" });
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
          profile: "host"
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
      profile: "guest",
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
      expect.objectContaining({ profile: "guest", threadId: "thread_1", turnId: "turn_1" })
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

  it("suspends active turns for an exited app-server profile without interrupting or failing messages", async () => {
    const { codex } = createDeferredCodex();
    const lark = createLarkResponder();
    const { repository } = createRepository();
    const manager = createManager({ repository, codex, lark, config: cardModeConfig() });

    manager.submitIncoming(message("m1", "first"));
    await waitForExpect(() => expect(lark.replyCard).toHaveBeenCalledTimes(1));

    await expect(manager.suspendActiveTurnsForCodexAppServerExit("host")).resolves.toBe(0);
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
  larkDocs?: LarkDocResolver;
  larkDocComments?: LarkDocCommentClient;
  larkFeatureConfig?: LarkFeatureConfigurationStatusProvider;
  botOpenId?: string;
  assetImageKeys?: ConstructorParameters<typeof ConversationManager>[0]["assetImageKeys"];
  workspaceRoot?: string;
  logger?: ConstructorParameters<typeof ConversationManager>[0]["logger"];
  config?: TwinnyConfig;
  telemetry?: TelemetryClient;
  runtime?: ConstructorParameters<typeof ConversationManager>[0]["runtime"];
} = {}): ConversationManager {
  const workspaceRoot = options.workspaceRoot ?? "/tmp/twinny/workspaces";
  const managerConfig = options.config ?? config;
  return new ConversationManager({
    config: managerConfig,
    repository: options.repository ?? createRepository().repository,
    workspaces: {
      ensureWorkspace: (key) => path.join(workspaceRoot, key)
    },
    profiles: {
      codexHomeFor: (profile) => managerConfig.profiles[profile].codexHome
    },
    codex: options.codex ?? createCodex(),
    lark: options.lark ?? createLarkResponder(),
    larkUsers: options.larkUsers ?? createLarkUserDirectory(),
    larkChats: options.larkChats,
    larkFiles: options.larkFiles,
    larkMessages: options.larkMessages,
    larkDocs: options.larkDocs,
    larkDocComments: options.larkDocComments,
    larkFeatureConfig: options.larkFeatureConfig,
    botOpenId: options.botOpenId,
    assetImageKeys: options.assetImageKeys,
    runtime: options.runtime,
    telemetry: options.telemetry,
    logger: options.logger,
    nameLookupFailureTtlMs: 60_000
  });
}

function missingFeatureResult(
  key: LarkFeatureCheckResult["key"],
  label: string,
  overrides: Partial<LarkFeatureCheckResult>
): LarkFeatureCheckResult {
  return {
    key,
    label,
    ok: false,
    skipped: false,
    missingScopes: [],
    missingEvents: [],
    missingCallbacks: [],
    nonLongConnectionEvents: [],
    nonLongConnectionCallbacks: [],
    hasPublishedVersion: true,
    ...overrides
  };
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

function createLarkDocResolver(): LarkDocResolver {
  return {
    resolveDocTarget: vi.fn(async (url) => {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const fileType = parts[0] === "sheets" ? "sheet" : parts[0] ?? "docx";
      return {
        fileType,
        fileToken: parts[1] ?? "doc_token",
        watchUrl: url
      };
    })
  };
}

function createLarkDocCommentClient(snapshot: LarkDocCommentSnapshot | null = larkDocCommentSnapshot()): LarkDocCommentClient {
  return {
    getCommentSnapshot: vi.fn(async () => snapshot),
    updateReaction: vi.fn(async () => undefined),
    replyToComment: vi.fn(async () => ({ replyId: "bot_reply_1", raw: {} })),
    downloadCommentImage: vi.fn(async ({ fileToken, outputDir }) => ({
      path: path.join(outputDir, `${fileToken}.png`),
      resourceType: "image" as const,
      fileKey: fileToken,
      fileName: `${fileToken}.png`,
      size: 123,
      contentType: "image/png"
    }))
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

interface CapturedTelemetryEvent {
  event: string;
  properties: TelemetryProperties;
  options: TelemetryCaptureOptions;
}

function createTelemetry(): TelemetryClient & { captured: CapturedTelemetryEvent[] } {
  const captured: CapturedTelemetryEvent[] = [];
  return {
    runtimeId: "runtime_test",
    captured,
    capture: vi.fn((event: string, properties: TelemetryProperties = {}, options: TelemetryCaptureOptions = {}) => {
      captured.push({ event, properties, options });
    }),
    captureError: vi.fn((_error: unknown, context: TelemetryErrorContext) => {
      captured.push({ event: "twinny_error", properties: context.properties ?? {}, options: context });
    }),
    hashId: vi.fn((kind: string, raw: string | null | undefined) => raw ? `hashed:${kind}:${raw.length}` : null)
  };
}

function capturedTelemetryEvents(telemetry: TelemetryClient, event: string): CapturedTelemetryEvent[] {
  return ((telemetry as TelemetryClient & { captured?: CapturedTelemetryEvent[] }).captured ?? []).filter((item) => item.event === event);
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
    readCodexVersion: vi.fn(() => "fake-codex 1.2.3"),
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
    sendTextToChatId: vi.fn(async (chatId) => ({ messageId: `text_${chatId}_${++markdownReplyCount}`, raw: {} })),
    sendPostToOpenId: vi.fn(async (openId) => ({ messageId: `post_${openId}_${++markdownReplyCount}`, raw: {} })),
    sendPostToChatId: vi.fn(async (chatId) => ({ messageId: `post_${chatId}_${++markdownReplyCount}`, raw: {} })),
    sendCardToOpenId: vi.fn(async (openId) => ({ messageId: `card_${openId}_${++markdownReplyCount}`, raw: {} })),
    sendCardToChatId: vi.fn(async (chatId) => ({ messageId: `card_${chatId}_${++markdownReplyCount}`, raw: {} })),
    sendEphemeralCardToChatId: vi.fn(async (chatId) => ({ messageId: `ephemeral_${chatId}_${++markdownReplyCount}`, raw: {} })),
    forwardThread: vi.fn(async (threadId) => ({ messageId: `forward_${threadId}_${++markdownReplyCount}`, raw: {} })),
    forwardThreadToThread: vi.fn(async (threadId) => ({ messageId: `forward_${threadId}_${++markdownReplyCount}`, raw: {} })),
    replyCard: vi.fn(async (messageId) => ({ messageId: `card_${messageId}_${++markdownReplyCount}` })),
    patchCard: vi.fn(async (messageId) => ({ messageId })),
    recallMessage: vi.fn(async () => undefined),
    deleteEphemeralMessage: vi.fn(async () => undefined),
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
  const larkDocWatchers = new Map<string, LarkDocWatcherRecord>();
  let nextCodexThreadId = 1;
  let nextLarkDocWatcherId = 1;
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
  const larkDocWatcherKey = (fileType: string, fileToken: string) => `${fileType}:${fileToken}`;
  const putCodexThread = (input: {
    codexThreadId: string;
    conversationKey: string;
    workspace?: string;
    profile: ProfileName;
    model?: string;
    effort?: string;
    category?: CodexThreadRecord["category"];
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
      workspace: input.workspace ?? existing?.workspace ?? row?.workspace ?? "/tmp/twinny/workspaces/p2p_ou_guest",
      name: input.name ?? existing?.name ?? "新会话",
      category: input.category ?? existing?.category ?? (input.larkThreadId ? "thread" : "previous_main"),
      larkThreadId: input.larkThreadId ?? existing?.larkThreadId,
      profile: input.profile,
      model: input.model ?? existing?.model,
      effort: input.effort ?? existing?.effort,
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
    update: {
      codexThreadId: string;
      profile: ProfileName;
      workspace?: string;
      model?: string;
      effort?: string;
      codexThreadHasRollout?: boolean;
    }
  ): CodexThreadRecord => {
    const existing = getCodexThreadByLarkThread(conversationKey, larkThreadId);
    if (existing) {
      codexThreads.delete(existing.codexThreadId);
    }
    const record = codexThreadRecord({
      id: existing?.id ?? nextCodexThreadId++,
      codexThreadId: update.codexThreadId,
      conversationKey,
      workspace: update.workspace ?? existing?.workspace ?? row?.workspace ?? "/tmp/twinny/workspaces/p2p_ou_guest",
      name: existing?.name ?? "新会话",
      category: "thread",
      larkThreadId,
      profile: update.profile,
      model: update.model ?? existing?.model,
      effort: update.effort ?? existing?.effort,
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
      workspace: row.workspace,
      profile: row.profile,
      codexThreadHasRollout: options.mainThreadHasRollout ?? true
    });
  }
  return {
    get row() {
      return row;
    },
    repository: {
      findByConversationKey: (conversationKey) => row?.conversationKey === conversationKey ? row : null,
      getCodexThreadById: vi.fn((codexThreadId) => codexThreads.get(codexThreadId)),
      getCodexThreadByConversationAndLarkThread: vi.fn(getCodexThreadByLarkThread),
      listCodexThreadsByConversation: vi.fn((conversationKey) =>
        [...codexThreads.values()]
          .filter((thread) => thread.conversationKey === conversationKey)
          .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id - left.id)
      ),
      countUnfinishedLarkMessagesByThread: vi.fn((codexThreadId) =>
        [...larkMessages.values()].filter((message) =>
          message.codexThreadId === codexThreadId &&
          (message.status === "processing" || message.status === "queued")
        ).length
      ),
      getLarkMessageById: vi.fn((larkMessageId) =>
        larkMessages.get(larkMessageId) ?? (larkMessageIds.has(larkMessageId) ? { larkMessageId } : undefined)
      ),
      getLarkMessageByEventId: vi.fn((eventId) => larkMessagesByEventId.get(eventId)),
      getLarkMessageUsageTargetForTurn: vi.fn((codexThreadId, codexTurnId) =>
        [...larkMessages.values()]
          .filter((message) =>
            message.codexThreadId === codexThreadId &&
            message.codexTurnId === codexTurnId &&
            message.larkMessageId !== undefined &&
            message.routeKind !== "steered_message" &&
            message.routeKind !== "doc_comment_reply_steer"
          )
          .sort((left, right) => left.receivedAt - right.receivedAt || left.id - right.id)[0]
      ),
      getLatestSteeredLarkMessageForTurn: vi.fn((codexThreadId, codexTurnId) =>
        [...larkMessages.values()]
          .filter((message) =>
            message.codexThreadId === codexThreadId &&
            message.codexTurnId === codexTurnId &&
            message.larkMessageId !== undefined &&
            message.routeKind === "steered_message"
          )
          .sort((left, right) => right.receivedAt - left.receivedAt || right.id - left.id)[0]
      ),
      listContiguousSteeredLarkMessagesBefore: vi.fn((record) => {
        const previous = [...larkMessages.values()]
          .filter((message) =>
            message.conversationKey === record.conversationKey &&
            message.codexThreadId === record.codexThreadId &&
            message.codexTurnId === record.codexTurnId &&
            (message.receivedAt < record.receivedAt ||
              (message.receivedAt === record.receivedAt && message.id < record.id))
          )
          .sort((left, right) => left.receivedAt - right.receivedAt || left.id - right.id);
        const contiguous: LarkMessageRecord[] = [];
        for (let index = previous.length - 1; index >= 0; index -= 1) {
          const message = previous[index]!;
          if (message.status !== "steered") {
            break;
          }
          contiguous.unshift(message);
        }
        return contiguous;
      }),
      listUnfinishedLarkMessages: vi.fn(() => [...larkMessages.values()].filter((message) =>
        message.status === "processing" || message.status === "queued"
      )),
      hasProcessedDocComment: vi.fn((commentId) =>
        [...larkMessages.values()].some((message) =>
          (message.routeKind === "doc_comment" || message.routeKind === "doc_comment_reply_steer") &&
          message.docCommentId === commentId
        )
      ),
      create: (record) => {
        const profile = record.profile ?? "guest";
        const profileCodexHome = record.profileCodexHome ?? config.profiles[profile].codexHome;
        row = {
          id: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...record,
          profile,
          profileCodexHome,
          responseMode: record.responseMode ?? (record.type === "p2p" ? "all" : "none")
        };
        putCodexThread({
          codexThreadId: row.codexThreadId,
          conversationKey: row.conversationKey,
          workspace: row.workspace,
          profile: row.profile,
          codexThreadHasRollout: false
        });
        return row;
      },
      updateThreadBinding: (_key, update) => {
        if (!row) {
          throw new Error("missing conversation");
        }
        Object.assign(row, update, { updatedAt: Date.now() });
        const thread = codexThreads.get(update.codexThreadId);
        if (thread) {
          thread.workspace = update.workspace ?? row.workspace;
          thread.updatedAt = row.updatedAt;
        }
        return row;
      },
      updateConversationSettings: (_key, update) => {
        if (!row) {
          throw new Error("missing conversation");
        }
        Object.assign(row, update, { updatedAt: Date.now() });
        return row;
      },
      updateConversationWorkspace: (_key, workspace) => {
        if (!row) {
          throw new Error("missing conversation");
        }
        row.workspace = workspace;
        row.updatedAt = Date.now();
        const thread = codexThreads.get(row.codexThreadId);
        if (thread) {
          thread.workspace = workspace;
          thread.updatedAt = row.updatedAt;
        }
        return row;
      },
      markThreadHasRollout: (_key, codexThreadId) => {
        const thread = codexThreads.get(codexThreadId);
        if (thread) {
          thread.codexThreadHasRollout = true;
          thread.updatedAt = Date.now();
        }
      },
      hasUserMessageForCodexThread: vi.fn((codexThreadId, excludeLarkMessageIds = []) => {
        const excluded = new Set(excludeLarkMessageIds);
        return [...larkMessages.values()].some((message) =>
          message.codexThreadId === codexThreadId &&
          !excluded.has(message.larkMessageId ?? "") &&
          (
            message.routeKind === "message" ||
            message.routeKind === "goal_message" ||
            message.routeKind === "steered_message" ||
            message.routeKind === "queued_message" ||
            message.routeKind === "doc_comment" ||
            message.routeKind === "doc_comment_reply_steer"
          )
        );
      }),
      upsertCodexThread: vi.fn(putCodexThread),
      replaceCodexThreadForLarkThread: vi.fn(replaceCodexThreadForLarkThread),
      updateCodexThreadTokenUsage: vi.fn((input) => {
        const existing = codexThreads.get(input.codexThreadId);
        const record = codexThreadRecord({
          ...existing,
          codexThreadId: input.codexThreadId,
          conversationKey: input.conversationKey,
          workspace: input.workspace ?? existing?.workspace ?? row?.workspace ?? "/tmp/twinny/workspaces/p2p_ou_guest",
          profile: input.profile,
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
          workspace: input.workspace ?? existing?.workspace ?? row?.workspace ?? "/tmp/twinny/workspaces/p2p_ou_guest",
          name: input.name ?? existing?.name ?? "新会话",
          larkThreadId: input.larkThreadId ?? existing?.larkThreadId,
          profile: input.profile,
          model: input.model ?? existing?.model,
          effort: input.effort ?? existing?.effort,
          creatorOpenId: input.creatorOpenId ?? existing?.creatorOpenId,
          cardMessageId: input.cardMessageId ?? existing?.cardMessageId,
          codexThreadHasRollout: existing?.codexThreadHasRollout ?? false,
          updatedAt: Date.now()
        });
        codexThreads.set(record.codexThreadId, record);
        return record;
      }),
      updateCodexThreadModelSettings: vi.fn((input) => {
        const existing = codexThreads.get(input.codexThreadId);
        if (!existing) {
          throw new Error("missing codex thread");
        }
        existing.model = input.model;
        existing.effort = input.effort;
        existing.updatedAt = Date.now();
        return existing;
      }),
      updateCodexThreadWorkspace: vi.fn((codexThreadId, workspace) => {
        const existing = codexThreads.get(codexThreadId);
        if (!existing) {
          throw new Error("missing codex thread");
        }
        existing.workspace = workspace;
        existing.updatedAt = Date.now();
        return existing;
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
      listRecentThreadWorkspaces: vi.fn((_since, limit = 10) => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const thread of [...codexThreads.values()].sort((left, right) => right.updatedAt - left.updatedAt)) {
          if (!thread.workspace || seen.has(thread.workspace)) {
            continue;
          }
          seen.add(thread.workspace);
          result.push(thread.workspace);
          if (result.length >= limit) {
            break;
          }
        }
        return result;
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
          docCommentId: input.docCommentId,
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
      updateLarkMessageTokenUsage: vi.fn((input) => {
        const existing = larkMessages.get(input.larkMessageId);
        if (!existing) {
          return undefined;
        }
        existing.inputTokens = input.inputTokens;
        existing.outputTokens = input.outputTokens;
        existing.cachedInputTokens = input.cachedInputTokens;
        existing.reasoningOutputTokens = input.reasoningOutputTokens;
        existing.tokenUsageJson = input.tokenUsageJson;
        existing.updatedAt = Date.now();
        return existing;
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
      markLarkMessagesSteered: vi.fn((messageIds, update = {}) => {
        const now = Date.now();
        for (const messageId of messageIds) {
          const existing = larkMessages.get(messageId);
          if (!existing) {
            continue;
          }
          existing.status = "steered";
          existing.conversationKey = update.conversationKey ?? existing.conversationKey;
          existing.codexThreadId = update.codexThreadId ?? existing.codexThreadId;
          existing.codexTurnId = update.codexTurnId ?? existing.codexTurnId;
          existing.updatedAt = now;
        }
      }),
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
      }),
      upsertLarkDocWatcher: vi.fn((input) => {
        const key = larkDocWatcherKey(input.fileType, input.fileToken);
        const existing = larkDocWatchers.get(key);
        const record: LarkDocWatcherRecord = {
          id: existing?.id ?? nextLarkDocWatcherId++,
          fileType: input.fileType,
          fileToken: input.fileToken,
          threadId: input.threadId,
          watchMode: input.watchMode,
          watchUrl: input.watchUrl,
          lastCommentReceivedAt: existing?.lastCommentReceivedAt,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now()
        };
        larkDocWatchers.set(key, record);
        return record;
      }),
      getLarkDocWatcherByFile: vi.fn((fileType, fileToken) =>
        larkDocWatchers.get(larkDocWatcherKey(fileType, fileToken))
      ),
      listLarkDocWatchersByThread: vi.fn((threadId) =>
        [...larkDocWatchers.values()].filter((watcher) => watcher.threadId === threadId)
      ),
      migrateLarkDocWatchersToThread: vi.fn((previousThreadId, nextThreadId) => {
        if (previousThreadId === nextThreadId) {
          return 0;
        }
        let migrated = 0;
        for (const watcher of larkDocWatchers.values()) {
          if (watcher.threadId !== previousThreadId) {
            continue;
          }
          watcher.threadId = nextThreadId;
          watcher.updatedAt = Date.now();
          migrated += 1;
        }
        return migrated;
      }),
      touchLarkDocWatcherCommentReceived: vi.fn((fileType, fileToken, receivedAt) => {
        const existing = larkDocWatchers.get(larkDocWatcherKey(fileType, fileToken));
        if (!existing) {
          return false;
        }
        existing.lastCommentReceivedAt = receivedAt;
        existing.updatedAt = Date.now();
        return true;
      })
    }
  };
}

function conversationRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  const record: ConversationRecord = {
    id: 1,
    conversationKey: "p2p_ou_guest",
    type: "p2p",
    chatId: "ou_guest",
    name: "Guest User",
    responseMode: "all",
    profile: "guest",
    codexThreadId: "thread_1",
    workspace: "/tmp/twinny/workspaces/p2p_ou_guest",
    profileCodexHome: "/tmp/twinny/profiles/guest/codex",
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  };
  const profile = overrides.profile ?? record.profile;
  record.profile = profile;
  record.profileCodexHome = overrides.profileCodexHome ?? record.profileCodexHome ?? `/tmp/twinny/profiles/${profile}/codex`;
  return record;
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
    routeKind === "side_message" ||
    routeKind === "doc_comment" ||
    routeKind === "doc_comment_reply_steer"
  );
}

function codexThreadRecord(overrides: Partial<CodexThreadRecord> = {}): CodexThreadRecord {
  const conversationKey = overrides.conversationKey ?? "p2p_ou_guest";
  const record: CodexThreadRecord = {
    id: 1,
    codexThreadId: "thread_1",
    conversationKey,
    workspace: `/tmp/twinny/workspaces/${conversationKey}`,
    name: "新会话",
    profile: "guest",
    category: "previous_main",
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
  const profile = overrides.profile ?? record.profile;
  record.profile = profile;
  return record;
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
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    tokenUsageJson: "{}",
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

function docCommentAdd(overrides: Partial<IncomingLarkDocCommentAdd> = {}): IncomingLarkDocCommentAdd {
  return {
    eventId: "event_doc_comment",
    fileType: "docx",
    fileToken: "doc_token",
    commentId: "comment_1",
    replyId: "reply_1",
    senderOpenId: "ou_owner",
    senderName: "Owner",
    isMentioned: true,
    createTime: 1234,
    raw: {},
    ...overrides
  };
}

function larkDocCommentSnapshot(overrides: Partial<LarkDocCommentSnapshot> = {}): LarkDocCommentSnapshot {
  return {
    fileType: "docx",
    fileToken: "doc_token",
    commentId: "comment_1",
    replyId: "reply_1",
    isWhole: false,
    authorOpenId: "ou_owner",
    authorName: "Owner",
    text: "Please inspect this",
    quoteBlockIds: [],
    imageKeys: [],
    isDone: false,
    isSolved: false,
    createTime: 1234,
    rawComment: { comment_id: "comment_1" },
    rawReply: { reply_id: "reply_1" },
    ...overrides
  };
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

function dynamicToolPayload(response: unknown): any {
  const item = (response as { contentItems?: Array<{ text?: string }> } | undefined)?.contentItems?.[0];
  expect(item?.text).toEqual(expect.any(String));
  return JSON.parse(item!.text!);
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
