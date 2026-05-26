import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProfileCodexAppServerPool } from "../codex/appserver.js";
import type { CodexRequestUserInputResponder, CodexTurnInput } from "../codex/turn.js";
import { createTwinnyConfig } from "../config/loader.js";
import {
  ConversationManager,
  type CodexBridge,
  type ConversationRepository as ManagerConversationRepository,
  type LarkResponder
} from "../conversation/manager.js";
import {
  LarkEventConsumer,
  type EventDispatcherLike,
  type WsClientLike
} from "../lark/events.js";
import { TenantAccessTokenManager } from "../lark/auth.js";
import { LarkChatDirectory, LarkUserDirectory } from "../lark/contact.js";
import { LarkFileDownloader } from "../lark/files.js";
import { LarkMessageReader, LarkMessageSender } from "../lark/messages.js";
import { LarkOpenApiClient } from "../lark/openapi.js";
import type { FetchLike, FetchResponseLike } from "../lark/types.js";
import {
  createConversationRepository,
  openTwinnyDatabase,
  type ConversationRepository as StoreConversationRepository,
  type TwinnyDatabase
} from "../store/index.js";
import type {
  CodexAgentMessage,
  CodexImageGeneration,
  CodexPlanUpdate,
  CodexRequestUserInputRequest,
  CodexThreadMode,
  CodexThreadTokenUsageUpdate,
  LarkReactionHandle,
  ProfileName,
  TwinnyConfig
} from "../types.js";
import { WorkspaceManager } from "../workspace/manager.js";

const harnesses: IntegrationHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("Lark to Codex integration flow", () => {
  it("starts a P2P Codex turn, steers a later Lark message, and replies through Lark APIs in order", async () => {
    const harness = await IntegrationHarness.create(`
{"profile":"guest","after":{"method":"turn/start","nth":1},"notify":{"method":"turn/started","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1"}}}}
{"profile":"guest","after":{"method":"turn/start","nth":1},"notify":{"method":"item/completed","params":{"threadId":"guest_thread_1","turnId":"turn_1","item":{"type":"agentMessage","id":"agent_1","text":"working on first","phase":"commentary"}}}}
{"profile":"guest","after":{"method":"turn/steer","nth":1},"notify":{"method":"item/completed","params":{"threadId":"guest_thread_1","turnId":"turn_1","item":{"type":"agentMessage","id":"agent_2","text":"final answer after steer","phase":"final_answer"}}}}
{"profile":"guest","after":{"method":"turn/steer","nth":1},"notify":{"method":"turn/completed","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1","status":"completed","durationMs":10,"items":[{"type":"agentMessage","id":"agent_2","text":"final answer after steer","phase":"final_answer"}]}}}}
`);

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_m1", messageId: "m1", text: "first request" }))}}
`);
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "first turn/start");

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_m2", messageId: "m2", text: "second request" }))}}
`);
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("final answer after steer")),
      "final card patch"
    );

    const trace = harness.readTrace();
    expect(codexOut(trace, "thread/start")[0]?.message.params).toMatchObject({
      cwd: path.join(harness.tempDir, "workspaces", "p2p_ou_guest"),
      approvalPolicy: "never",
      persistExtendedHistory: true
    });
    expect(codexOut(trace, "turn/start")[0]?.message.params).toMatchObject({
      threadId: "guest_thread_1",
      approvalPolicy: "never"
    });
    expect(traceText(codexOut(trace, "turn/start")[0])).toContain("lark_message_id");
    expect(traceText(codexOut(trace, "turn/start")[0])).toContain("m1");
    expect(traceText(codexOut(trace, "turn/start")[0])).toContain("first request");
    expect(codexOut(trace, "turn/steer")[0]?.message.params).toMatchObject({
      threadId: "guest_thread_1",
      expectedTurnId: "turn_1"
    });
    expect(traceText(codexOut(trace, "turn/steer")[0])).toContain("lark_message_id");
    expect(traceText(codexOut(trace, "turn/steer")[0])).toContain("m2");
    expect(traceText(codexOut(trace, "turn/steer")[0])).toContain("second request");
    expectOrder(trace, [
      ["thread/start", (entry) => isCodexMethod(entry, "thread/start")],
      ["typing reaction", (entry) => isLarkRequest(entry, "POST", "/im/v1/messages/m1/reactions")],
      ["turn/start", (entry) => isCodexMethod(entry, "turn/start")],
      ["turn/steer", (entry) => isCodexMethod(entry, "turn/steer")],
      ["clear typing reaction", (entry) => isLarkRequest(entry, "DELETE", "/im/v1/messages/m2/reactions/r_m2")],
      ["final card", (entry) => entry.kind === "lark.out" && entry.method === "PATCH" && traceText(entry).includes("final answer after steer")]
    ]);
  });

  it("waits through retryable Codex turn errors before failing on a terminal error", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_1" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        delayMs: 20,
        notify: {
          method: "error",
          params: {
            message: "Reconnecting... 1/5",
            willRetry: true,
            error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } },
            additionalDetails: "stream disconnected before completion"
          }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        delayMs: 50,
        notify: {
          method: "error",
          params: {
            message: "Reconnecting... 2/5",
            willRetry: true,
            error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } },
            additionalDetails: "stream disconnected before completion"
          }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        delayMs: 250,
        notify: {
          method: "error",
          params: {
            message: "terminal stream failure",
            willRetry: false
          }
        }
      }
    ));

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_retry_error", messageId: "m_retry_error", text: "trigger retryable errors" })
    }));
    await harness.waitForTrace(
      (trace) => codexErrorNotifications(trace).filter((entry) => codexErrorWillRetry(entry) === true).length === 2,
      "two retryable Codex errors"
    );

    expect(harness.repository.getLarkMessageById("m_retry_error")).toMatchObject({ status: "processing" });
    expect(
      larkOut(harness.readTrace()).some((entry) => entry.method === "PATCH" && traceText(entry).includes("[ERROR]"))
    ).toBe(false);

    await harness.waitForTrace(
      (trace) => codexErrorNotifications(trace).some((entry) => codexErrorWillRetry(entry) === false),
      "terminal Codex error"
    );
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("m_retry_error")).toMatchObject({ status: "failed" });
      expect(
        larkOut(harness.readTrace()).some(
          (entry) => entry.method === "PATCH" && traceText(entry).includes("- [ERROR] terminal stream failure")
        )
      ).toBe(true);
    });

    const trace = harness.readTrace();
    expectOrder(trace, [
      ["first retryable error", (entry) => isCodexRetryableError(entry)],
      [
        "second retryable error",
        (entry, index, all) =>
          isCodexRetryableError(entry) && all.slice(0, index).filter((item) => isCodexRetryableError(item)).length === 1
      ],
      ["terminal error", (entry) => isCodexTerminalError(entry)],
      [
        "failed card patch",
        (entry) => entry.kind === "lark.out" && entry.method === "PATCH" && traceText(entry).includes("- [ERROR] terminal stream failure")
      ]
    ]);
  });

  it("keeps queued Lark messages out of Codex when they are recalled before the current turn finishes", async () => {
    const harness = await IntegrationHarness.create(`
{"profile":"guest","after":{"method":"turn/start","nth":1},"notify":{"method":"turn/started","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1"}}}}
{"profile":"guest","after":{"method":"turn/start","nth":1},"delayMs":120,"notify":{"method":"turn/completed","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1","status":"completed","durationMs":10,"items":[{"type":"agentMessage","id":"agent_done","text":"done","phase":"final_answer"}]}}}}
`);

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_m1", messageId: "m1", text: "long task" }))}}
`);
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "active turn");

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_m2", messageId: "m2", text: "/queue queued task" }))}}
`);
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("m2")).toMatchObject({ status: "queued" });
    });

    await harness.dispatchLarkJsonl(`
{"event":"im.message.recalled_v1","data":${JSON.stringify(recallEvent({ eventId: "e_recall_m2", messageId: "m2" }))}}
`);

    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("m2")).toMatchObject({ status: "recalled" });
    });
    await waitForDelay(180);

    const trace = harness.readTrace();
    expect(codexOut(trace, "turn/start")).toHaveLength(1);
    expect(traceText(codexOut(trace, "turn/start")[0])).not.toContain("queued task");
    expect(larkOut(trace).some((entry) => entry.method === "POST" && entry.path === "/im/v1/messages/m2/reactions")).toBe(true);
    expect(larkOut(trace).some((entry) => entry.method === "DELETE" && entry.path === "/im/v1/messages/m2/reactions/queued_m2")).toBe(true);
  });

  it("runs a queued /goal command only after the active turn completes", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_1" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        delayMs: 160,
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "turn_1",
              status: "completed",
              durationMs: 160,
              items: [{ type: "agentMessage", id: "active_done", text: "active done", phase: "final_answer" }]
            }
          }
        }
      },
      {
        profile: "guest",
        on: { method: "thread/goal/set", nth: 1 },
        reply: {
          goal: {
            threadId: "guest_thread_1",
            objective: "ship queued goal /plan ignored",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "goal_turn_queued" } } }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        notify: {
          method: "item/completed",
          params: {
            threadId: "guest_thread_1",
            turnId: "goal_turn_queued",
            item: { type: "agentMessage", id: "queued_goal_final", text: "goal complete", phase: "final_answer" }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        delayMs: 500,
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "goal_turn_queued",
              status: "completed",
              durationMs: 500,
              items: [{ type: "agentMessage", id: "queued_goal_final", text: "goal complete", phase: "final_answer" }]
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        delayMs: 520,
        notify: {
          method: "thread/goal/updated",
          params: {
            threadId: "guest_thread_1",
            turnId: "goal_turn_queued",
            goal: {
              threadId: "guest_thread_1",
              objective: "ship queued goal /plan ignored",
              status: "complete",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 2
            }
          }
        }
      }
    ));

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_goal_active", messageId: "m_goal_active", text: "active before queued goal" })
    }));
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "active turn/start");

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_goal_queued",
        messageId: "m_goal_queued",
        text: "/queue /goal ship queued goal /plan ignored"
      })
    }));
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("m_goal_queued")).toMatchObject({
        routeKind: "goal_message",
        status: "queued",
        text: "ship queued goal /plan ignored"
      });
    });
    await waitForDelay(40);
    expect(codexOut(harness.readTrace(), "thread/goal/set")).toHaveLength(0);

    await harness.waitForTrace((trace) => codexOut(trace, "thread/goal/set").length === 1, "queued goal set");
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("实现目标中") && traceText(entry).includes("goal complete")),
      "queued goal final while still working"
    );
    expect(harness.repository.getLarkMessageById("m_goal_queued")).toMatchObject({ status: "processing" });
    expect(
      larkOut(harness.readTrace()).some((entry) => entry.method === "PATCH" && traceText(entry).includes("已实现目标"))
    ).toBe(false);

    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("已实现目标") && traceText(entry).includes("goal complete")),
      "queued goal completed card"
    );

    const trace = harness.readTrace();
    const goalSet = codexOut(trace, "thread/goal/set")[0]!;
    expect(goalSet.message.params).toMatchObject({
      threadId: "guest_thread_1",
      objective: "ship queued goal /plan ignored",
      status: "active"
    });
    expect(goalSet.message.params).not.toHaveProperty("tokenBudget");
    expect(codexOut(trace, "turn/start")).toHaveLength(1);
    expect(harness.repository.getLarkMessageById("m_goal_active")).toMatchObject({ status: "completed" });
    expect(harness.repository.getLarkMessageById("m_goal_queued")).toMatchObject({ status: "completed" });
    expectOrder(trace, [
      ["active turn/start", (entry) => isCodexMethod(entry, "turn/start")],
      ["active done card", (entry) => entry.kind === "lark.out" && entry.method === "PATCH" && traceText(entry).includes("active done")],
      ["queued goal set", (entry) => isCodexMethod(entry, "thread/goal/set")],
      ["queued goal complete card", (entry) => entry.kind === "lark.out" && entry.method === "PATCH" && traceText(entry).includes("已实现目标")]
    ]);
  });

  it("updates a goal card status line when Codex reports turn token usage", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        on: { method: "thread/goal/set", nth: 1 },
        reply: {
          goal: {
            threadId: "guest_thread_1",
            objective: "show goal token usage",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "goal_turn_token_usage" } } }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        delayMs: 80,
        notify: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "guest_thread_1",
            turnId: "goal_turn_token_usage",
            tokenUsage: {
              total: {
                totalTokens: 27_210,
                inputTokens: 27_000,
                cachedInputTokens: 21_600,
                outputTokens: 210
              },
              last: {
                totalTokens: 57_000
              },
              modelContextWindow: 100_000
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        delayMs: 180,
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "goal_turn_token_usage",
              status: "completed",
              durationMs: 180,
              items: [{ type: "agentMessage", id: "goal_token_done", text: "goal token done", phase: "final_answer" }]
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        delayMs: 200,
        notify: {
          method: "thread/goal/updated",
          params: {
            threadId: "guest_thread_1",
            turnId: "goal_turn_token_usage",
            goal: {
              threadId: "guest_thread_1",
              objective: "show goal token usage",
              status: "complete",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 2
            }
          }
        }
      }
    ));

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_goal_token_usage", messageId: "m_goal_token_usage", text: "/goal show goal token usage" })
    }));

    await harness.waitForTrace((trace) => codexOut(trace, "thread/goal/set").length === 1, "goal set");
    await harness.waitForTrace(
      (trace) => larkOut(trace).some(
        (entry) =>
          entry.method === "PATCH" &&
          traceText(entry).includes("实现目标中") &&
          traceText(entry).includes("57% · ↑ 27 K (80% Cached) ↓ 210")
      ),
      "goal card token usage status line"
    );
  });

  it("keeps a late final answer as the completed goal card body when goal completion arrives before turn completion", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        on: { method: "thread/goal/set", nth: 1 },
        reply: {
          goal: {
            threadId: "guest_thread_1",
            objective: "finish after terminal goal update",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        notify: {
          method: "turn/started",
          params: { threadId: "guest_thread_1", turn: { id: "late_goal_turn" } }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        notify: {
          method: "item/completed",
          params: {
            threadId: "guest_thread_1",
            turnId: "late_goal_turn",
            item: {
              type: "agentMessage",
              id: "goal_process_before_terminal",
              text: "process before terminal goal update",
              phase: "commentary"
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        delayMs: 20,
        notify: {
          method: "thread/goal/updated",
          params: {
            threadId: "guest_thread_1",
            turnId: "late_goal_turn",
            goal: {
              threadId: "guest_thread_1",
              objective: "finish after terminal goal update",
              status: "complete",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 2
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        delayMs: 2_300,
        notify: {
          method: "item/completed",
          params: {
            threadId: "guest_thread_1",
            turnId: "late_goal_turn",
            item: {
              type: "agentMessage",
              id: "late_goal_final",
              text: "late final goal answer",
              phase: "final_answer"
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        delayMs: 2_320,
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "late_goal_turn",
              status: "completed",
              durationMs: 100,
              items: [{ type: "agentMessage", id: "late_goal_final", text: "late final goal answer", phase: "final_answer" }]
            }
          }
        }
      }
    ));

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_goal_terminal_first",
        messageId: "m_goal_terminal_first",
        text: "/goal finish after terminal goal update"
      })
    }));

    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("已实现目标")),
      "goal completed card before late turn completion",
      3_000
    );

    const completedCards = larkOut(harness.readTrace()).filter((entry) =>
      entry.method === "PATCH" &&
      traceText(entry).includes("已实现目标")
    );
    expect(completedCards.length).toBeGreaterThan(0);
    const completedCard = completedCards.at(-1)!;
    const completedCardText = traceText(completedCard);
    expect(completedCardText).toContain("late final goal answer");
    expect(completedCard.bodyContentJson).toMatchObject({
      config: { summary: { content: "late final goal answer" } }
    });
    expect(harness.repository.getLarkMessageById("m_goal_terminal_first")).toMatchObject({ status: "completed" });
  });

  it("switches an ordinary turn card to a goal card after a passive Codex goal update", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_passive_goal" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        delayMs: 60,
        notify: {
          method: "thread/goal/updated",
          params: {
            threadId: "guest_thread_1",
            turnId: "turn_passive_goal",
            goal: {
              threadId: "guest_thread_1",
              objective: "passive integration goal",
              status: "active",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 2
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        delayMs: 160,
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "turn_passive_goal",
              status: "interrupted",
              durationMs: 160,
              items: []
            }
          }
        }
      }
    ));

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_passive_goal", messageId: "m_passive_goal", text: "start passive goal" })
    }));

    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) =>
        entry.method === "PATCH" &&
        traceText(entry).includes("实现目标中：passive integration goal")
      ),
      "passive goal working card"
    );
    await harness.waitForExpect(() => {
      expect(harness.repository.getCodexThreadById("guest_thread_1")).toMatchObject({
        goalStatus: "active",
        goalUpdatedAt: 2
      });
    });
  });

  it("updates a queued turn card after it starts behind a completed goal", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        on: { method: "thread/goal/set", nth: 1 },
        reply: {
          goal: {
            threadId: "guest_thread_1",
            objective: "finish goal before queued turn",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "goal_turn_before_queue" } } }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        delayMs: 180,
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "goal_turn_before_queue",
              status: "completed",
              durationMs: 180,
              items: [{ type: "agentMessage", id: "goal_done_before_queue", text: "goal before queue done", phase: "final_answer" }]
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        delayMs: 200,
        notify: {
          method: "thread/goal/updated",
          params: {
            threadId: "guest_thread_1",
            turnId: "goal_turn_before_queue",
            goal: {
              threadId: "guest_thread_1",
              objective: "finish goal before queued turn",
              status: "complete",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 2
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "queued_turn_after_goal" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        delayMs: 50,
        notify: {
          method: "item/completed",
          params: {
            threadId: "guest_thread_1",
            turnId: "queued_turn_after_goal",
            item: { type: "agentMessage", id: "queued_progress_after_goal", text: "queued turn progress after goal", phase: "commentary" }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        delayMs: 120,
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "queued_turn_after_goal",
              status: "completed",
              durationMs: 120,
              items: [{ type: "agentMessage", id: "queued_final_after_goal", text: "queued final after goal", phase: "final_answer" }]
            }
          }
        }
      }
    ));

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_goal_before_queue", messageId: "m_goal_before_queue", text: "/goal finish goal before queued turn" })
    }));
    await harness.waitForTrace((trace) => codexOut(trace, "thread/goal/set").length === 1, "goal set");

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_queued_after_goal", messageId: "m_queued_after_goal", text: "/queue queued turn after goal" })
    }));
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("m_queued_after_goal")).toMatchObject({ status: "queued" });
    });

    await harness.waitForTrace(
      (trace) => codexOut(trace, "turn/start").some((entry) => traceText(entry).includes("queued turn after goal")),
      "queued turn starts after goal"
    );
    await harness.waitForTrace(
      (trace) => larkOut(trace).some(
        (entry) =>
          entry.method === "PATCH" &&
          entry.path.includes("m_queued_after_goal") &&
          traceText(entry).includes("queued turn progress after goal")
      ),
      "queued turn progress card patch"
    );
  });

  it("does not duplicate queued messages when recovering an active goal after app-server restart", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        on: { method: "thread/goal/set", nth: 1 },
        reply: {
          goal: {
            threadId: "guest_thread_1",
            objective: "keep goal running",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/set", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "goal_turn_before_restart" } } }
      },
      {
        profile: "guest",
        on: { method: "thread/goal/get", nth: 1 },
        reply: {
          goal: {
            threadId: "guest_thread_1",
            objective: "keep goal running",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/get", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "goal_turn_after_restart" } } }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/get", nth: 1 },
        delayMs: 60,
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "goal_turn_after_restart",
              status: "completed",
              durationMs: 60,
              items: [{ type: "agentMessage", id: "goal_after_restart_final", text: "goal after restart complete", phase: "final_answer" }]
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/goal/get", nth: 1 },
        delayMs: 70,
        notify: {
          method: "thread/goal/updated",
          params: {
            threadId: "guest_thread_1",
            turnId: "goal_turn_after_restart",
            goal: {
              threadId: "guest_thread_1",
              objective: "keep goal running",
              status: "complete",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 2
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        delayMs: 20,
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "turn_1",
              status: "completed",
              durationMs: 20,
              items: [{ type: "agentMessage", id: "queued_after_restart_done_1", text: "queued after restart done", phase: "final_answer" }]
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 2 },
        delayMs: 20,
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "turn_2",
              status: "completed",
              durationMs: 20,
              items: [{ type: "agentMessage", id: "queued_after_restart_done_2", text: "queued after restart done again", phase: "final_answer" }]
            }
          }
        }
      }
    ));

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_goal_restart", messageId: "m_goal_restart", text: "/goal keep goal running" })
    }));
    await harness.waitForTrace((trace) => codexOut(trace, "thread/goal/set").length === 1, "goal set before restart");

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_queue_restart", messageId: "m_queue_restart", text: "/queue queued after restart" })
    }));
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("m_queue_restart")).toMatchObject({ status: "queued" });
    });

    await harness.recoverCodexAppServer("guest");
    await harness.waitForTrace((trace) => codexOut(trace, "thread/goal/get").length === 1, "goal recovered after restart");
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("已实现目标")),
      "recovered goal completed"
    );
    await harness.waitForTrace(
      (trace) => codexOut(trace, "turn/start").some((entry) => traceText(entry).includes("queued after restart")),
      "queued message started after recovered goal"
    );
    await waitForDelay(150);

    const queuedStarts = codexOut(harness.readTrace(), "turn/start")
      .filter((entry) => traceText(entry).includes("queued after restart"));
    expect(queuedStarts).toHaveLength(1);
  });

  it("covers plan mode questions before accepting and implementing the plan", async () => {
    const harness = await IntegrationHarness.create(`
{"profile":"guest","after":{"method":"turn/start","nth":1},"notify":{"method":"turn/started","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1"}}}}
{"profile":"guest","after":{"method":"turn/start","nth":1},"request":{"id":"question_1","method":"item/tool/requestUserInput","params":{"threadId":"guest_thread_1","turnId":"turn_1","itemId":"item_question","questions":[{"id":"scope","header":"Scope","question":"Need scope?","isOther":false,"isSecret":false,"options":[{"label":"Full coverage","description":"Exercise the complete flow."},{"label":"Minimal","description":"Only the smallest path."}]}]}}}
{"profile":"guest","afterResponse":{"id":"question_1"},"notify":{"method":"item/completed","params":{"threadId":"guest_thread_1","turnId":"turn_1","item":{"type":"plan","text":"Plan ready after question"}}}}
{"profile":"guest","afterResponse":{"id":"question_1"},"notify":{"method":"turn/completed","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1","status":"completed","durationMs":12,"items":[{"type":"plan","text":"Plan ready after question"}]}}}}
{"profile":"guest","after":{"method":"turn/start","nth":2},"notify":{"method":"turn/started","params":{"threadId":"guest_thread_1","turn":{"id":"turn_2"}}}}
{"profile":"guest","after":{"method":"turn/start","nth":2},"notify":{"method":"turn/completed","params":{"threadId":"guest_thread_1","turn":{"id":"turn_2","status":"completed","durationMs":8,"items":[{"type":"agentMessage","id":"implement_done","text":"implemented","phase":"final_answer"}]}}}}
`);

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_plan", messageId: "m_plan", text: "/plan draft the integration test plan" }))}}
`);
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "plan turn/start");
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("Need scope?")),
      "waiting input card"
    );

    const firstTurn = codexOut(harness.readTrace(), "turn/start")[0]!;
    expect(firstTurn.message.params).toMatchObject({
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.5",
          reasoning_effort: "medium",
          developer_instructions: null
        }
      }
    });

    await harness.dispatchLarkJsonl(`
{"event":"card.action.trigger","data":${JSON.stringify(cardActionEvent({
  eventId: "e_answer",
  action: "request_input_submit",
  stateKey: "p2p_ou_guest",
  runId: 1,
  formValue: {
    answer_scope_select: "Full coverage"
  }
}))}}
`);
    await harness.waitForTrace(
      (trace) => codexResponses(trace, "question_1").some((entry) => traceText(entry).includes("Full coverage")),
      "Codex question response"
    );
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("Plan ready after question")),
      "waiting plan card"
    );

    await harness.dispatchLarkJsonl(`
{"event":"card.action.trigger","data":${JSON.stringify(cardActionEvent({
  eventId: "e_implement",
  action: "plan_implement",
  stateKey: "p2p_ou_guest",
  runId: 1,
  formValue: {
    plan_implement_instruction: "cover question flow too"
  }
}))}}
`);
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 2, "implement turn/start");
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("implemented")),
      "implement final card"
    );

    const trace = harness.readTrace();
    const implementTurn = codexOut(trace, "turn/start")[1]!;
    expect(traceText(implementTurn)).toContain("Implement the plan with following instruction: cover question flow too");
    expectOrder(trace, [
      ["plan turn/start", (entry) => isCodexMethod(entry, "turn/start")],
      ["request user input response", (entry) => isCodexResponse(entry, "question_1")],
      ["waiting plan card", (entry) => entry.kind === "lark.out" && entry.method === "PATCH" && traceText(entry).includes("Plan ready after question")],
      ["implement turn/start", (entry, index, all) => isCodexMethod(entry, "turn/start") && all.slice(0, index).filter((item) => isCodexMethod(item, "turn/start")).length === 1]
    ]);
  });

  it("exits plan waiting without briefly creating a queued reaction", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_1" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: {
          method: "item/completed",
          params: { threadId: "guest_thread_1", turnId: "turn_1", item: { type: "plan", text: "Plan ready for direct exit" } }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "turn_1",
              status: "completed",
              durationMs: 8,
              items: [{ type: "plan", text: "Plan ready for direct exit" }]
            }
          }
        }
      }
    ));

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_plan_exit_start", messageId: "m_plan_exit_start", text: "/plan prepare direct exit" })
    }));
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("Plan ready for direct exit")),
      "plan waiting card"
    );

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_plan_exit", messageId: "m_plan_exit", text: "/exit" })
    }));
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.path === "/im/v1/messages/m_plan_exit/reply" && traceText(entry).includes("已退出 plan mode")),
      "exit plan reply"
    );

    const trace = harness.readTrace();
    expect(codexOut(trace, "turn/interrupt")).toHaveLength(1);
    expect(larkOut(trace).filter((entry) => entry.method === "POST" && entry.path === "/im/v1/messages/m_plan_exit/reactions")).toHaveLength(0);
    await harness.dispose();
  });

  it("activates group routing and only forwards mentioned group messages to Codex", async () => {
    const harness = await IntegrationHarness.create(`
{"profile":"guest","after":{"method":"turn/start","nth":1},"notify":{"method":"turn/started","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1"}}}}
{"profile":"guest","after":{"method":"turn/start","nth":1},"notify":{"method":"turn/completed","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1","status":"completed","durationMs":6,"items":[{"type":"agentMessage","id":"group_done","text":"group done","phase":"final_answer"}]}}}}
`);

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_group_ignored", messageId: "g0", text: "plain before activation", chatType: "group", chatId: "oc_group", senderOpenId: "ou_guest" }))}}
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_group_unauthorized", messageId: "g1", text: "@_bot hello", chatType: "group", chatId: "oc_group", senderOpenId: "ou_guest", mentions: [botMention()] }))}}
`);
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.path === "/im/v1/messages/g1/reply" && traceText(entry).includes("activate")),
      "group unauthorized reply"
    );
    expect(codexOut(harness.readTrace(), "turn/start")).toHaveLength(0);

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_activate", messageId: "g2", text: "/activate all_at guest", chatType: "group", chatId: "oc_group", senderOpenId: "ou_owner" }))}}
`);
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.path === "/im/v1/messages/g2/reply" && traceText(entry).includes("Profile")),
      "group activation reply"
    );

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_group_no_at", messageId: "g3", text: "plain after activation", chatType: "group", chatId: "oc_group", senderOpenId: "ou_guest" }))}}
`);
    await waitForDelay(30);
    expect(codexOut(harness.readTrace(), "turn/start")).toHaveLength(0);

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_group_forward", messageId: "g4", text: "@_bot run group task", chatType: "group", chatId: "oc_group", senderOpenId: "ou_guest", mentions: [botMention()] }))}}
`);
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "group turn/start");

    const groupTurn = codexOut(harness.readTrace(), "turn/start")[0]!;
    expect(traceText(groupTurn)).toContain("run group task");
    expect(traceText(groupTurn)).not.toContain("@_bot");
  });

  it("downloads rich Lark post image and media resources before sending the turn to Codex", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_1" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "turn_1",
              status: "completed",
              durationMs: 6,
              items: [{ type: "agentMessage", id: "resource_done", text: "resource done", phase: "final_answer" }]
            }
          }
        }
      }
    ));
    const richPostContent = {
      zh_cn: {
        title: "Incident",
        content: [
          [{ tag: "text", text: "Please inspect " }, { tag: "img", image_key: "img_in_1" }],
          [{ tag: "text", text: "Playback " }, { tag: "media", file_key: "video_in_1" }]
        ]
      }
    };

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_resource",
        messageId: "m_resource",
        messageType: "post",
        content: JSON.stringify(richPostContent)
      })
    }));
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "resource turn/start");

    const trace = harness.readTrace();
    const resourceRequests = larkOut(trace).filter((entry) => entry.method === "GET" && entry.path.includes("/resources/"));
    expect(resourceRequests).toHaveLength(2);
    expect(resourceRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "/im/v1/messages/m_resource/resources/img_in_1",
        query: { type: "image" }
      }),
      expect.objectContaining({
        path: "/im/v1/messages/m_resource/resources/video_in_1",
        query: { type: "file" }
      })
    ]));

    const expectedResourceDir = path.join(harness.tempDir, "workspaces", "p2p_ou_guest", ".twinny", "lark_files", "m_resource");
    const turnText = traceText(codexOut(trace, "turn/start")[0]);
    expect(turnText).toContain("# Incident");
    expect(turnText).toContain("lark_file_key=\\\"img_in_1\\\"");
    expect(turnText).toContain("lark_file_key=\\\"video_in_1\\\"");
    expect(turnText).toContain(path.join(expectedResourceDir, "img_in_1.png"));
    expect(turnText).toContain(path.join(expectedResourceDir, "clip.mp4"));
    expect(turnText).toContain("\"type\":\"localImage\"");
  });

  it("uploads SEND_TO_LARK image, video, and file outputs and replies with the expected Lark payloads", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        files: [
          { path: "{{cwd}}/result.png", content: "png" },
          { path: "{{cwd}}/demo.mp4", content: "mp4" },
          { path: "{{cwd}}/report.pdf", content: "pdf" }
        ],
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_1" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "turn_1",
              status: "completed",
              durationMs: 6,
              items: [
                {
                  type: "agentMessage",
                  id: "artifact_done",
                  phase: "final_answer",
                  text:
                    "Artifacts ready\n" +
                    "SEND_TO_LARK: <img path=\"{{cwd}}/result.png\"></img>\n" +
                    "SEND_TO_LARK: <video path=\"{{cwd}}/demo.mp4\"></video>\n" +
                    "SEND_TO_LARK: <file path=\"{{cwd}}/report.pdf\"></file>"
                }
              ]
            }
          }
        }
      }
    ));

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_artifacts", messageId: "m_artifacts", text: "produce artifacts" })
    }));
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.path === "/im/v1/messages/m_artifacts/reply" && traceText(entry).includes("file_uploaded_")),
      "artifact file reply"
    );

    const trace = harness.readTrace();
    const imageUpload = larkOut(trace).find((entry) => entry.path === "/im/v1/images");
    const fileUploads = larkOut(trace).filter((entry) => entry.path === "/im/v1/files");
    expect(imageUpload?.body).toMatchObject({
      formData: {
        image_type: "message",
        image: { name: "result.png", size: 3, type: "image/png" }
      }
    });
    expect(fileUploads).toHaveLength(2);
    expect(fileUploads.map((entry) => entry.body)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        formData: expect.objectContaining({
          file_type: "mp4",
          file_name: "demo.mp4",
          file: { name: "demo.mp4", size: 3, type: "video/mp4" }
        })
      }),
      expect.objectContaining({
        formData: expect.objectContaining({
          file_type: "pdf",
          file_name: "report.pdf",
          file: { name: "report.pdf", size: 3, type: "application/pdf" }
        })
      })
    ]));
    expect(JSON.stringify(trace)).toContain("img_uploaded_");
    expect(JSON.stringify(trace)).toContain("file_uploaded_");
    expect(larkOut(trace)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "POST",
        path: "/im/v1/messages/m_artifacts/reply",
        bodyContentJson: expect.objectContaining({ file_key: expect.stringContaining("file_uploaded_") })
      })
    ]));
  });

  it("keeps compact traffic ordered: ordinary messages queue, steer is rejected, and stop interrupts compact", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_1" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "turn_1",
              status: "completed",
              durationMs: 6,
              items: [{ type: "agentMessage", id: "ready", text: "ready", phase: "final_answer" }]
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "thread/compact/start", nth: 1 },
        delayMs: 80,
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "compact_1" } } }
      },
      {
        profile: "guest",
        after: { method: "thread/compact/start", nth: 1 },
        delayMs: 260,
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: { id: "compact_1", status: "completed", durationMs: 260, items: [] }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/interrupt", nth: 1 },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: { id: "compact_1", status: "interrupted", durationMs: 90, items: [] }
          }
        }
      }
    ));

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_compact_prepare", messageId: "m_compact_prepare", text: "prepare thread" })
    }));
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("m_compact_prepare")).toMatchObject({ status: "completed" });
    });

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_compact", messageId: "m_compact", text: "/compact" })
    }));
    await harness.waitForTrace((trace) => codexOut(trace, "thread/compact/start").length === 1, "compact request");

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_compact_during", messageId: "m_compact_during", text: "message before compact started" })
    }));
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("m_compact_during")).toMatchObject({ status: "queued" });
    });
    await harness.waitForTrace(
      (trace) => trace.some((entry) => entry.kind === "codex.in" && traceText(entry).includes("compact_1") && traceText(entry).includes("turn/started")),
      "compact started notification"
    );

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_compact_steer", messageId: "m_compact_steer", text: "/steer" })
    }));
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.path === "/im/v1/messages/m_compact_steer/reply" && traceText(entry).includes("compact")),
      "compact steer rejection"
    );

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_compact_stop", messageId: "m_compact_stop", text: "/stop" })
    }));
    await harness.waitForTrace((trace) => codexOut(trace, "turn/interrupt").length === 1, "compact interrupt");
    await harness.waitForTrace((items) => {
      const interruptId = codexOut(items, "turn/interrupt")[0]?.id;
      return interruptId !== undefined && items.some((entry) => entry.kind === "codex.in" && entry.message.id === interruptId);
    }, "compact interrupt response");
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("m_compact_during")).toMatchObject({ status: "cleared" });
    });

    const trace = harness.readTrace();
    const queuedAt = larkOut(trace).find((entry) => entry.path === "/im/v1/messages/m_compact_during/reactions")?.at;
    const compactStartedAt = trace.find(
      (entry) => entry.kind === "codex.in" && traceText(entry).includes("compact_1") && traceText(entry).includes("turn/started")
    )?.at;
    expect(queuedAt).toBeDefined();
    expect(larkOut(trace).some((entry) => entry.path === "/im/v1/messages/m_compact_stop/reply")).toBe(false);
    expect(compactStartedAt).toBeDefined();
    expect(queuedAt!).toBeLessThan(compactStartedAt!);
    expect(codexOut(trace, "turn/steer")).toHaveLength(0);
  });

  it("creates a Lark thread with /thread and routes later topic messages through the new Codex thread", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_2", turn: { id: "turn_1" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_2",
            turn: {
              id: "turn_1",
              status: "completed",
              durationMs: 7,
              items: [{ type: "agentMessage", id: "thread_first", text: "thread first done", phase: "final_answer" }]
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 2 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_2", turn: { id: "turn_2" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 2 },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_2",
            turn: {
              id: "turn_2",
              status: "completed",
              durationMs: 7,
              items: [{ type: "agentMessage", id: "thread_followup", text: "thread followup done", phase: "final_answer" }]
            }
          }
        }
      }
    ));

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_thread_activate",
        messageId: "g_thread_activate",
        text: "/activate all guest",
        chatType: "group",
        chatId: "oc_group",
        senderOpenId: "ou_owner"
      })
    }));
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.path === "/im/v1/messages/g_thread_activate/reply" && traceText(entry).includes("Profile")),
      "thread group activation"
    );

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_thread_command",
        messageId: "g_thread_command",
        text: "/thread investigate thread flow",
        chatType: "group",
        chatId: "oc_group",
        senderOpenId: "ou_guest"
      })
    }));
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "thread proxy turn/start");

    const createdThreadId = "thread_reply_send_2_3";
    let trace = harness.readTrace();
    expect(codexOut(trace, "thread/start")).toHaveLength(2);
    expect(codexOut(trace, "turn/start")[0]?.message.params).toMatchObject({ threadId: "guest_thread_2" });
    expect(traceText(codexOut(trace, "turn/start")[0])).toContain("investigate thread flow");
    expect(larkOut(trace)).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "POST", path: "/im/v1/messages", query: { receive_id_type: "chat_id" } }),
      expect.objectContaining({
        method: "POST",
        path: "/im/v1/messages/send_2/reply",
        body: expect.objectContaining({ reply_in_thread: true })
      }),
      expect.objectContaining({ method: "DELETE", path: "/im/v1/messages/g_thread_command" })
    ]));

    await harness.waitForTrace(
      (items) => larkOut(items).some((entry) => entry.method === "PATCH" && traceText(entry).includes("thread first done")),
      "thread first final card"
    );
    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_thread_followup",
        messageId: "g_thread_followup",
        text: "follow-up in new thread",
        chatType: "topic_group",
        chatId: "oc_group",
        threadId: createdThreadId,
        rootId: createdThreadId,
        senderOpenId: "ou_guest"
      })
    }));
    await harness.waitForTrace((items) => codexOut(items, "turn/start").length === 2, "thread follow-up turn/start");
    await harness.waitForTrace(
      (items) => larkOut(items).some((entry) => entry.path === "/im/v1/messages/g_thread_followup/reply" && traceText(entry).includes("interactive")),
      "thread follow-up replied in current topic"
    );

    trace = harness.readTrace();
    expect(codexOut(trace, "thread/resume")[0]?.message.params).toMatchObject({ threadId: "guest_thread_2" });
    expect(codexOut(trace, "turn/start")[1]?.message.params).toMatchObject({ threadId: "guest_thread_2" });
    expect(traceText(codexOut(trace, "turn/start")[1])).toContain("follow-up in new thread");
    expect(larkOut(trace).some((entry) => entry.path === "/im/v1/messages/g_thread_followup/reply")).toBe(true);
  });

  it("handles card controls for queue/next, skipped question input, and rejected plan mode", async () => {
    const queueHarness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_1" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/interrupt", nth: 1 },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: { id: "turn_1", status: "interrupted", durationMs: 10, items: [] }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 2 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_2" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 2 },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "turn_2",
              status: "completed",
              durationMs: 6,
              items: [{ type: "agentMessage", id: "queued_finished", text: "queued finished", phase: "final_answer" }]
            }
          }
        }
      }
    ));
    await queueHarness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_card_active", messageId: "m_card_active", text: "long card task" })
    }));
    await queueHarness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "card active turn");
    await queueHarness.dispatchLarkJsonl(jsonl({
      event: "card.action.trigger",
      data: cardActionEvent({
        eventId: "e_card_queue_unauthorized",
        action: "queue",
        stateKey: "p2p_ou_guest",
        runId: 1,
        operatorOpenId: "ou_other"
      })
    }));
    await queueHarness.dispatchLarkJsonl(jsonl({
      event: "card.action.trigger",
      data: cardActionEvent({ eventId: "e_card_queue", action: "queue", stateKey: "p2p_ou_guest", runId: 1 })
    }));
    await queueHarness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_card_queued", messageId: "m_card_queued", text: "queued by card" })
    }));
    await queueHarness.waitForExpect(() => {
      expect(queueHarness.repository.getLarkMessageById("m_card_queued")).toMatchObject({ status: "queued" });
    });
    await queueHarness.dispatchLarkJsonl(jsonl({
      event: "card.action.trigger",
      data: cardActionEvent({ eventId: "e_card_next", action: "next", stateKey: "p2p_ou_guest", runId: 1 })
    }));
    await queueHarness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 2, "card next starts queued turn");
    await queueHarness.waitForTrace(
      (items) => larkOut(items).some((entry) => entry.method === "PATCH" && traceText(entry).includes("queued finished")),
      "card queued turn final card"
    );
    let trace = queueHarness.readTrace();
    expect(codexOut(trace, "turn/interrupt")).toHaveLength(1);
    expect(traceText(codexOut(trace, "turn/start")[1])).toContain("queued by card");
    expect(JSON.stringify(trace)).not.toContain("e_card_queue_unauthorized");
    await queueHarness.dispose();

    const inputHarness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_1" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        request: {
          id: "skip_question_1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "guest_thread_1",
            turnId: "turn_1",
            itemId: "item_question",
            questions: [
              {
                id: "detail",
                header: "Detail",
                question: "Need details?",
                isOther: false,
                isSecret: false,
                options: [{ label: "Use defaults", description: "Continue with defaults." }]
              }
            ]
          }
        }
      },
      {
        profile: "guest",
        afterResponse: { id: "skip_question_1" },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "turn_1",
              status: "completed",
              durationMs: 8,
              items: [{ type: "agentMessage", id: "skip_done", text: "skip done", phase: "final_answer" }]
            }
          }
        }
      }
    ));
    await inputHarness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_skip_input", messageId: "m_skip_input", text: "ask me" })
    }));
    await inputHarness.waitForTrace(
      (items) => larkOut(items).some((entry) => entry.method === "PATCH" && traceText(entry).includes("Need details?")),
      "input waiting card"
    );
    await inputHarness.dispatchLarkJsonl(jsonl({
      event: "card.action.trigger",
      data: cardActionEvent({ eventId: "e_skip_action", action: "request_input_interrupt", stateKey: "p2p_ou_guest", runId: 1 })
    }));
    await inputHarness.waitForTrace(
      (items) => codexResponses(items, "skip_question_1").some((entry) => traceText(entry).includes("user skip the question")),
      "skipped input response"
    );
    await inputHarness.waitForExpect(() => {
      expect(inputHarness.repository.getLarkMessageById("m_skip_input")).toMatchObject({ status: "completed" });
    });
    await inputHarness.dispose();

    const planHarness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_1" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: {
          method: "item/completed",
          params: { threadId: "guest_thread_1", turnId: "turn_1", item: { type: "plan", text: "Plan to reject" } }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: { id: "turn_1", status: "completed", durationMs: 8, items: [{ type: "plan", text: "Plan to reject" }] }
          }
        }
      }
    ));
    await planHarness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({ eventId: "e_plan_reject", messageId: "m_plan_reject", text: "/plan propose only" })
    }));
    await planHarness.waitForTrace(
      (items) => larkOut(items).some((entry) => entry.method === "PATCH" && traceText(entry).includes("Plan to reject")),
      "plan waiting card"
    );
    await planHarness.dispatchLarkJsonl(jsonl({
      event: "card.action.trigger",
      data: cardActionEvent({ eventId: "e_plan_interrupt", action: "plan_interrupt", stateKey: "p2p_ou_guest", runId: 1 })
    }));
    await planHarness.waitForTrace((items) => codexOut(items, "turn/interrupt").length === 1, "plan interrupt");
    await planHarness.waitForTrace((items) => {
      const interruptId = codexOut(items, "turn/interrupt")[0]?.id;
      return interruptId !== undefined && items.some((entry) => entry.kind === "codex.in" && entry.message.id === interruptId);
    }, "plan interrupt response");
    trace = planHarness.readTrace();
    expect(codexOut(trace, "turn/start")).toHaveLength(1);
    await planHarness.dispose();
  });

  it("queues different-user group messages during an active turn while preserving authorized owner stop", async () => {
    const harness = await IntegrationHarness.create(jsonl(
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_1" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 1 },
        delayMs: 180,
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "turn_1",
              status: "completed",
              durationMs: 180,
              items: [{ type: "agentMessage", id: "guest_done", text: "guest done", phase: "final_answer" }]
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 2 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_2" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 2 },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: {
              id: "turn_2",
              status: "completed",
              durationMs: 6,
              items: [{ type: "agentMessage", id: "other_done", text: "other done", phase: "final_answer" }]
            }
          }
        }
      },
      {
        profile: "guest",
        after: { method: "turn/start", nth: 3 },
        notify: { method: "turn/started", params: { threadId: "guest_thread_1", turn: { id: "turn_3" } } }
      },
      {
        profile: "guest",
        after: { method: "turn/interrupt", nth: 1 },
        notify: {
          method: "turn/completed",
          params: {
            threadId: "guest_thread_1",
            turn: { id: "turn_3", status: "interrupted", durationMs: 8, items: [] }
          }
        }
      }
    ));

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_multi_activate",
        messageId: "g_multi_activate",
        text: "/activate all guest",
        chatType: "group",
        chatId: "oc_group",
        senderOpenId: "ou_owner"
      })
    }));
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.path === "/im/v1/messages/g_multi_activate/reply" && traceText(entry).includes("Profile")),
      "multi-user group activation"
    );

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_multi_guest",
        messageId: "g_multi_guest",
        text: "guest active task",
        chatType: "group",
        chatId: "oc_group",
        senderOpenId: "ou_guest"
      })
    }));
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "guest active turn");
    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_multi_other",
        messageId: "g_multi_other",
        text: "other user should queue",
        chatType: "group",
        chatId: "oc_group",
        senderOpenId: "ou_other"
      })
    }));
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("g_multi_other")).toMatchObject({ status: "queued" });
    });
    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_multi_other_next",
        messageId: "g_multi_other_next",
        text: "/next",
        chatType: "group",
        chatId: "oc_group",
        senderOpenId: "ou_other"
      })
    }));
    await waitForDelay(30);
    expect(codexOut(harness.readTrace(), "turn/steer")).toHaveLength(0);
    expect(codexOut(harness.readTrace(), "turn/interrupt")).toHaveLength(0);

    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 2, "different user queued turn");
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("g_multi_other")).toMatchObject({ status: "completed" });
    });
    let trace = harness.readTrace();
    expect(traceText(codexOut(trace, "turn/start")[1])).toContain("other user should queue");
    expect(traceText(codexOut(trace, "turn/start")[1])).toContain("ou_other");

    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_multi_stop_active",
        messageId: "g_multi_stop_active",
        text: "guest active task for owner stop",
        chatType: "group",
        chatId: "oc_group",
        senderOpenId: "ou_guest"
      })
    }));
    await harness.waitForTrace((items) => codexOut(items, "turn/start").length === 3, "owner stop active turn");
    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_multi_stop_queued",
        messageId: "g_multi_stop_queued",
        text: "queued before owner stop",
        chatType: "group",
        chatId: "oc_group",
        senderOpenId: "ou_other"
      })
    }));
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("g_multi_stop_queued")).toMatchObject({ status: "queued" });
    });
    await harness.dispatchLarkJsonl(jsonl({
      event: "im.message.receive_v1",
      data: receiveMessageEvent({
        eventId: "e_multi_owner_stop",
        messageId: "g_multi_owner_stop",
        text: "/stop",
        chatType: "group",
        chatId: "oc_group",
        senderOpenId: "ou_owner"
      })
    }));
    await harness.waitForTrace((items) => codexOut(items, "turn/interrupt").length === 1, "owner stop interrupt");
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("g_multi_stop_queued")).toMatchObject({ status: "cleared" });
    });
    await waitForDelay(30);
    trace = harness.readTrace();
    expect(codexOut(trace, "turn/start")).toHaveLength(3);
    expect(larkOut(trace).some((entry) => entry.path === "/im/v1/messages/g_multi_owner_stop/reply")).toBe(false);
  });
});

class IntegrationHarness {
  readonly tempDir: string;
  readonly traceFile: string;
  readonly repository: StoreConversationRepository;

  private readonly db: TwinnyDatabase;
  private readonly pool: ProfileCodexAppServerPool;
  private readonly manager: ConversationManager;
  private readonly consumer: LarkEventConsumer;
  private readonly registered: Record<string, (data: unknown) => unknown> = {};
  private disposed = false;

  private constructor(options: {
    tempDir: string;
    traceFile: string;
    db: TwinnyDatabase;
    repository: StoreConversationRepository;
    pool: ProfileCodexAppServerPool;
    manager: ConversationManager;
    consumer: LarkEventConsumer;
    registered: Record<string, (data: unknown) => unknown>;
  }) {
    this.tempDir = options.tempDir;
    this.traceFile = options.traceFile;
    this.db = options.db;
    this.repository = options.repository;
    this.pool = options.pool;
    this.manager = options.manager;
    this.consumer = options.consumer;
    Object.assign(this.registered, options.registered);
  }

  static async create(codexScriptJsonl: string): Promise<IntegrationHarness> {
    larkId = 0;
    FakeLarkApi.reset();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-integration-"));
    const traceFile = path.join(tempDir, "trace.jsonl");
    const scriptFile = path.join(tempDir, "codex-script.jsonl");
    fs.writeFileSync(scriptFile, normalizeJsonl(codexScriptJsonl), "utf8");
    const fakeCodexBinary = createFakeCodexBinary(tempDir, traceFile, scriptFile);
    const config = createIntegrationConfig(tempDir, fakeCodexBinary);
    const db = openTwinnyDatabase(path.join(tempDir, "sqlite", "twinny.db"));
    const repository = createConversationRepository(db);
    const pool = new ProfileCodexAppServerPool({
      binary: fakeCodexBinary,
      profiles: config.profiles,
      requestTimeoutMs: 2_000,
      clientVersion: "integration-test",
      env: {
        PATH: process.env.PATH,
        HOME: tempDir
      }
    });
    await pool.startAll();

    const larkApi = new FakeLarkApi(traceFile);
    const tokenManager = new TenantAccessTokenManager({
      appId: config.auth.larkAppId,
      appSecret: "secret",
      fetch: larkApi.fetch,
      now: () => 1_000_000
    });
    const openApiClient = new LarkOpenApiClient({
      tokenManager,
      fetch: larkApi.fetch,
      maxRetries: 0
    });
    const larkSender = new LarkMessageSender({ openApiClient });
    const manager = new ConversationManager({
      config,
      repository: adaptConversationRepository(repository),
      workspaces: WorkspaceManager.fromTwinnyHome(tempDir),
      profiles: {
        codexHomeFor: (profile) => config.profiles[profile].codexHome
      },
      codex: adaptCodexPool(pool),
      lark: adaptLarkSender(larkSender, config),
      larkUsers: new LarkUserDirectory({ openApiClient }),
      larkChats: new LarkChatDirectory({ openApiClient }),
      larkFiles: new LarkFileDownloader({ openApiClient }),
      larkMessages: new LarkMessageReader({ openApiClient }),
      botOpenId: "ou_bot",
      logger: silentLogger(),
      nameLookupFailureTtlMs: 1
    });
    const registered: Record<string, (data: unknown) => unknown> = {};
    const dispatcher: EventDispatcherLike = {
      register(handles) {
        Object.assign(registered, handles);
        return this;
      }
    };
    const wsClient: WsClientLike = {
      start: () => undefined,
      close: () => undefined
    };
    const consumer = new LarkEventConsumer({
      appId: config.auth.larkAppId,
      appSecret: "secret",
      warmTenantToken: false,
      botOpenId: "ou_bot",
      onMessage: (message) => {
        manager.submitIncoming(message);
      },
      onMessageRecall: (recall) => {
        manager.submitMessageRecall(recall);
      },
      onBotMenu: (action) => {
        manager.submitBotMenuAction(action);
      },
      onCardAction: (action) => {
        manager.submitCardAction(action);
      },
      maxMessageAgeMs: 60_000,
      now: () => 1_000,
      eventDispatcherFactory: () => dispatcher,
      wsClientFactory: () => wsClient
    });
    await consumer.start();

    const harness = new IntegrationHarness({
      tempDir,
      traceFile,
      db,
      repository,
      pool,
      manager,
      consumer,
      registered
    });
    larkApi.setMessageObserver((raw) => harness.rememberMessageRaw(raw));
    harnesses.push(harness);
    return harness;
  }

  async dispatchLarkJsonl(jsonl: string): Promise<void> {
    for (const item of parseJsonl<LarkEventInput>(jsonl)) {
      if (item.atMs && item.atMs > 0) {
        await waitForDelay(item.atMs);
      }
      this.rememberMessageRaw(item.data);
      const handler = this.registered[item.event];
      if (!handler) {
        throw new Error(`No Lark event handler registered for ${item.event}`);
      }
      await handler(item.data);
    }
  }

  async waitForTrace(predicate: (trace: TraceEntry[]) => boolean, label: string, timeoutMs = 1_500): Promise<void> {
    await this.waitForExpect(() => {
      const trace = this.readTrace();
      expect(predicate(trace), `${label}\n${JSON.stringify(trace, null, 2)}`).toBe(true);
    }, timeoutMs);
  }

  async waitForExpect(assertion: () => void, timeoutMs = 1_500): Promise<void> {
    const startedAt = Date.now();
    let lastError: unknown;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
        await waitForDelay(5);
      }
    }
    throw lastError;
  }

  async recoverCodexAppServer(profile: ProfileName): Promise<void> {
    await this.manager.suspendActiveTurnsForCodexAppServerExit(profile);
    await this.pool.get(profile).stop();
    await this.pool.restart(profile);
    await this.manager.recoverSuspendedActiveTurnsForCodexAppServerExit(profile);
  }

  readTrace(): TraceEntry[] {
    if (!fs.existsSync(this.traceFile)) {
      return [];
    }
    return fs
      .readFileSync(this.traceFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEntry);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.consumer.stop({ force: true }).catch(() => undefined);
    await this.pool.stopAll().catch(() => undefined);
    this.db.close();
    fs.rmSync(this.tempDir, { recursive: true, force: true });
  }

  private rememberMessageRaw(raw: unknown): void {
    FakeLarkApi.rememberGlobalMessage(raw);
  }
}

class FakeLarkApi {
  private static readonly messageRawById = new Map<string, unknown>();
  private messageObserver?: (raw: unknown) => void;

  constructor(private readonly traceFile: string) {}

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const apiPath = url.pathname.replace(/^\/open-apis/, "");
    const method = init?.method ?? "GET";
    const body = await parseRequestBody(init?.body);
    appendTrace(this.traceFile, {
      kind: "lark.out",
      method,
      path: apiPath,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      bodyContentJson: parseBodyContent(body)
    });

    if (apiPath === "/auth/v3/tenant_access_token/internal") {
      return jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
    }
    if (apiPath === "/bot/v3/info") {
      return jsonResponse({ code: 0, data: { open_id: "ou_bot" } });
    }
    const contactMatch = /^\/contact\/v3\/users\/([^/]+)$/.exec(apiPath);
    if (contactMatch) {
      const openId = decodeURIComponent(contactMatch[1]!);
      return jsonResponse({
        code: 0,
        data: {
          user: {
            name: openId === "ou_owner" ? "Owner User" : "Guest User"
          }
        }
      });
    }
    const chatMatch = /^\/im\/v1\/chats\/([^/]+)$/.exec(apiPath);
    if (chatMatch && method === "GET") {
      return jsonResponse({
        code: 0,
        data: {
          chat: {
            chat_id: decodeURIComponent(chatMatch[1]!),
            name: "Team Room",
            chat_mode: "group",
            group_message_type: "chat"
          }
        }
      });
    }
    if (apiPath === "/im/v1/messages/mget") {
      const ids = (url.searchParams.get("message_ids") ?? "").split(",").filter(Boolean);
      return jsonResponse({
        code: 0,
        data: {
          items: ids.map((id) => this.fetchedMessage(id)).filter(Boolean)
        }
      });
    }
    const readUsersMatch = /^\/im\/v1\/messages\/([^/]+)\/read_users$/.exec(apiPath);
    if (readUsersMatch) {
      return jsonResponse({ code: 0, data: { items: [], has_more: false } });
    }
    const reactionCreateMatch = /^\/im\/v1\/messages\/([^/]+)\/reactions$/.exec(apiPath);
    if (reactionCreateMatch && method === "POST") {
      const messageId = decodeURIComponent(reactionCreateMatch[1]!);
      const reactionType = asRecord(body)?.reaction_type;
      const emoji = asRecord(reactionType)?.emoji_type;
      const prefix = emoji === "OneSecond" ? "queued" : emoji === "DONE" ? "done" : "r";
      return jsonResponse({ code: 0, data: { reaction_id: `${prefix}_${messageId}` } });
    }
    if (/^\/im\/v1\/messages\/[^/]+\/reactions\/[^/]+$/.test(apiPath) && method === "DELETE") {
      return jsonResponse({ code: 0, data: {} });
    }
    const replyMatch = /^\/im\/v1\/messages\/([^/]+)\/reply$/.exec(apiPath);
    if (replyMatch && method === "POST") {
      const sourceMessageId = decodeURIComponent(replyMatch[1]!);
      const messageId = `reply_${sourceMessageId}_${nextLarkId()}`;
      return jsonResponse({ code: 0, data: { message_id: messageId, thread_id: `thread_${messageId}` } });
    }
    if (apiPath === "/im/v1/messages" && method === "POST") {
      const messageId = `send_${nextLarkId()}`;
      return jsonResponse({ code: 0, data: { message_id: messageId, thread_id: `thread_${messageId}` } });
    }
    const messagePatchOrDeleteMatch = /^\/im\/v1\/messages\/([^/]+)$/.exec(apiPath);
    if (messagePatchOrDeleteMatch && (method === "PATCH" || method === "DELETE")) {
      return jsonResponse({ code: 0, data: { message_id: decodeURIComponent(messagePatchOrDeleteMatch[1]!) } });
    }
    const resourceMatch = /^\/im\/v1\/messages\/[^/]+\/resources\/[^/]+$/.exec(apiPath);
    if (resourceMatch && method === "GET") {
      const resourceKey = decodeURIComponent(apiPath.split("/").pop() ?? "resource");
      const resourceType = url.searchParams.get("type");
      if (resourceType === "image" || resourceKey.startsWith("img")) {
        return binaryResponse(Buffer.from("fake-image"), "image/png", `attachment; filename="${resourceKey}.png"`);
      }
      const fileName = resourceKey.includes("video") ? "clip.mp4" : `${resourceKey}.pdf`;
      const contentType = fileName.endsWith(".mp4") ? "video/mp4" : "application/pdf";
      return binaryResponse(Buffer.from("fake-resource"), contentType, `attachment; filename="${fileName}"`);
    }
    if (apiPath === "/im/v1/images") {
      return jsonResponse({ code: 0, data: { image_key: `img_uploaded_${nextLarkId()}` } });
    }
    if (apiPath === "/im/v1/files") {
      return jsonResponse({ code: 0, data: { file_key: `file_uploaded_${nextLarkId()}` } });
    }
    const forwardMatch = /^\/im\/v1\/threads\/([^/]+)\/forward$/.exec(apiPath);
    if (forwardMatch && method === "POST") {
      const sourceThreadId = decodeURIComponent(forwardMatch[1]!);
      const messageId = `forward_${nextLarkId()}`;
      return jsonResponse({ code: 0, data: { message_id: messageId, thread_id: sourceThreadId } });
    }
    return jsonResponse({ code: 0, data: {} });
  };

  setMessageObserver(observer: (raw: unknown) => void): void {
    this.messageObserver = observer;
  }

  static rememberGlobalMessage(raw: unknown): void {
    const message = eventMessage(raw);
    const messageId = typeof message?.message_id === "string" ? message.message_id : undefined;
    if (messageId) {
      FakeLarkApi.messageRawById.set(messageId, raw);
    }
  }

  static reset(): void {
    FakeLarkApi.messageRawById.clear();
  }

  private fetchedMessage(messageId: string): unknown {
    const raw = FakeLarkApi.messageRawById.get(messageId);
    const message = eventMessage(raw);
    if (!message) {
      return undefined;
    }
    this.messageObserver?.(raw);
    return {
      ...message,
      msg_type: message.message_type,
      body: {
        content: message.content
      }
    };
  }
}

let larkId = 0;

function nextLarkId(): number {
  larkId += 1;
  return larkId;
}

function adaptConversationRepository(repository: StoreConversationRepository): ManagerConversationRepository {
  return {
    findByConversationKey: (conversationKey) => repository.getByConversationKey(conversationKey) ?? null,
    create: repository.create.bind(repository),
    updateThreadBinding: repository.updateThreadBinding.bind(repository),
    updateConversationSettings: repository.updateConversationSettings.bind(repository),
    markThreadHasRollout: repository.markThreadHasRollout.bind(repository),
    getCodexThreadById: repository.getCodexThreadById.bind(repository),
    getCodexThreadByConversationAndLarkThread: repository.getCodexThreadByConversationAndLarkThread.bind(repository),
    getLarkMessageById: repository.getLarkMessageById.bind(repository),
    getLarkMessageByEventId: repository.getLarkMessageByEventId.bind(repository),
    getLarkMessageUsageTargetForTurn: repository.getLarkMessageUsageTargetForTurn.bind(repository),
    getLatestSteeredLarkMessageForTurn: repository.getLatestSteeredLarkMessageForTurn.bind(repository),
    listUnfinishedLarkMessages: repository.listUnfinishedLarkMessages.bind(repository),
    upsertCodexThread: repository.upsertCodexThread.bind(repository),
    replaceCodexThreadForLarkThread: repository.replaceCodexThreadForLarkThread.bind(repository),
    updateCodexThreadTokenUsage: repository.updateCodexThreadTokenUsage.bind(repository),
    updateCodexThreadGoalStatus: repository.updateCodexThreadGoalStatus.bind(repository),
    clearCodexThreadGoalStatus: repository.clearCodexThreadGoalStatus.bind(repository),
    updateCodexThreadCard: repository.updateCodexThreadCard.bind(repository),
    updateCodexThreadModelSettings: repository.updateCodexThreadModelSettings.bind(repository),
    updateCodexThreadName: repository.updateCodexThreadName.bind(repository),
    updateCodexThreadMode: repository.updateCodexThreadMode.bind(repository),
    updateCodexThreadStatus: repository.updateCodexThreadStatus.bind(repository),
    getCodexThreadWorkStats: repository.getCodexThreadWorkStats.bind(repository),
    getCodexThreadStatusStats: repository.getCodexThreadStatusStats.bind(repository),
    getConversationStatusStats: repository.getConversationStatusStats.bind(repository),
    insertLarkMessage: repository.insertLarkMessage.bind(repository),
    markLarkMessageQueued: repository.markLarkMessageQueued.bind(repository),
    markLarkMessageRecalled: repository.markLarkMessageRecalled.bind(repository),
    updateQueuedLarkMessage: repository.updateQueuedLarkMessage.bind(repository),
    updateLarkMessageTokenUsage: repository.updateLarkMessageTokenUsage.bind(repository),
    markLarkMessagesProcessing: repository.markLarkMessagesProcessing.bind(repository),
    markLarkMessagesSteered: repository.markLarkMessagesSteered.bind(repository),
    markLarkMessagesCompleted: repository.markLarkMessagesCompleted.bind(repository),
    markLarkMessagesFailed: repository.markLarkMessagesFailed.bind(repository),
    markLarkMessagesInterrupted: repository.markLarkMessagesInterrupted.bind(repository),
    markLarkMessagesCleared: repository.markLarkMessagesCleared.bind(repository),
    upsertLarkDocWatcher: repository.upsertLarkDocWatcher.bind(repository),
    getLarkDocWatcherByFile: repository.getLarkDocWatcherByFile.bind(repository),
    listLarkDocWatchersByThread: repository.listLarkDocWatchersByThread.bind(repository),
    touchLarkDocWatcherCommentReceived: repository.touchLarkDocWatcherCommentReceived.bind(repository)
  };
}

function adaptCodexPool(pool: ProfileCodexAppServerPool): CodexBridge {
  return {
    startThread: async ({
      profile,
      cwd,
      developerInstructions
    }: {
      profile: ProfileName;
      cwd: string;
      developerInstructions?: string;
    }) => {
      const response = await pool.get(profile).startThread(cwd, { developerInstructions });
      return { threadId: response.thread.id };
    },
    resumeThread: async ({ profile, threadId, cwd }: { profile: ProfileName; threadId: string; cwd: string }) => {
      const response = await pool.get(profile).resumeThread(threadId, cwd);
      return { threadId: response.thread.id };
    },
    forkThread: async ({ profile, threadId, cwd, developerInstructions }) => {
      const response = await pool.get(profile).forkThread(threadId, cwd, { developerInstructions });
      return { threadId: response.thread.id };
    },
    startTurn: async ({
      profile,
      threadId,
      input,
      cwd,
      mode,
      model,
      effort,
      onTurnStarted,
      onAgentMessage,
      onImageGeneration,
      onTokenUsage,
      onGoalUpdated,
      onGoalCleared,
      onPlanUpdated,
      onRequestUserInput
    }: {
      profile: ProfileName;
      threadId: string;
      input: CodexTurnInput;
      cwd: string;
      mode?: CodexThreadMode;
      model?: string;
      effort?: string;
      onTurnStarted?: (turnId: string) => Promise<void> | void;
      onAgentMessage?: (message: CodexAgentMessage) => Promise<void> | void;
      onImageGeneration?: (image: CodexImageGeneration) => Promise<void> | void;
      onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
      onGoalUpdated?: Parameters<NonNullable<CodexBridge["runGoal"]>>[0]["onGoalUpdated"];
      onGoalCleared?: Parameters<NonNullable<CodexBridge["runGoal"]>>[0]["onGoalCleared"];
      onPlanUpdated?: (plan: CodexPlanUpdate) => Promise<void> | void;
      onRequestUserInput?: (
        request: CodexRequestUserInputRequest,
        responder: CodexRequestUserInputResponder
      ) => Promise<void> | void;
    }) =>
      pool.get(profile).startTurn({
        threadId,
        ...(typeof input === "string" ? { text: input } : { input }),
        cwd,
        mode,
        model,
        effort,
        onTurnStarted,
        onAgentMessage,
        onImageGeneration,
        onTokenUsage,
        onGoalUpdated,
        onGoalCleared,
        onPlanUpdated,
        onRequestUserInput
      }),
    compactThread: async ({ profile, threadId, cwd, onTurnStarted, onTokenUsage }) =>
      pool.get(profile).compactThread({ threadId, cwd, onTurnStarted, onTokenUsage }),
    setThreadGoal: async ({ profile, threadId, objective }) => pool.get(profile).setThreadGoal(threadId, objective),
    getThreadGoal: async ({ profile, threadId }) => pool.get(profile).getThreadGoal(threadId),
    clearThreadGoal: async ({ profile, threadId }) => {
      await pool.get(profile).clearThreadGoal(threadId);
    },
    runGoal: async ({ profile, ...options }) => pool.get(profile).runGoal(options),
    resumeGoal: async ({ profile, ...options }) => pool.get(profile).resumeGoal(options),
    steerTurn: async ({ profile, threadId, turnId, input }) => {
      await pool.get(profile).steerTurn({
        threadId,
        turnId,
        ...(typeof input === "string" ? { text: input } : { input })
      });
    },
    interruptTurn: async ({ profile, threadId, turnId }) => {
      await pool.get(profile).interruptTurn({ threadId, turnId });
    },
    readCodexVersion: ({ profile }) => pool.get(profile).readCodexVersion(),
    readAccountRateLimits: async ({ profile }) => pool.get(profile).readAccountRateLimits()
  };
}

function adaptLarkSender(sender: LarkMessageSender, config: TwinnyConfig): LarkResponder {
  return {
    addTypingReaction: (messageId: string): Promise<LarkReactionHandle | null> =>
      sender.createReaction(messageId, config.lark.workingReaction),
    addCompletedReaction: (messageId: string): Promise<LarkReactionHandle | null> =>
      sender.createReaction(messageId, config.lark.completedReaction),
    addQueuedReaction: (messageId: string): Promise<LarkReactionHandle | null> =>
      sender.createReaction(messageId, config.lark.queuedReaction),
    removeReaction: (handle) => sender.deleteReaction(handle),
    replyText: (messageId, text, options) => sender.replyText(messageId, text, options),
    replyMarkdown: (messageId, markdown, options) => sender.replyMarkdown(messageId, markdown, options),
    replyPost: (messageId, content, options) => sender.replyPost(messageId, content, options),
    replyFile: (messageId, fileKey) => sender.replyFile(messageId, fileKey),
    replyImage: (messageId, imageKey) => sender.replyImage(messageId, imageKey),
    sendTextToOpenId: (openId, text) => sender.sendTextToOpenId(openId, text),
    sendTextToChatId: (chatId, text) => sender.sendTextToChatId(chatId, text),
    sendCardToOpenId: (openId, card, options) => sender.sendInteractiveCardToOpenId(openId, card, options),
    sendCardToChatId: (chatId, card, options) => sender.sendInteractiveCardToChatId(chatId, card, options),
    sendEphemeralCardToChatId: (chatId, openId, card) =>
      sender.sendEphemeralInteractiveCardToChatId(chatId, openId, card),
    forwardThreadToThread: (threadId, receiveThreadId, options) =>
      sender.forwardThreadToThread(threadId, receiveThreadId, options),
    replyCard: (messageId, card, options) => sender.replyInteractiveCard(messageId, card, options),
    patchCard: (messageId, card) => sender.patchInteractiveCard(messageId, card),
    recallMessage: (messageId) => sender.deleteMessage(messageId),
    deleteEphemeralMessage: (messageId) => sender.deleteEphemeralMessage(messageId),
    getMessageReadOpenIds: (messageId) => sender.listMessageReadOpenIds(messageId)
  };
}

function createIntegrationConfig(tempDir: string, fakeCodexBinary: string): TwinnyConfig {
  return createTwinnyConfig({
    home: tempDir,
    homeRandom: "0123456789abcdef0123456789abcdef",
    auth: {
      larkAppId: "cli_integration",
      larkBrand: "feishu",
      ownerOpenId: "ou_owner",
      displayName: "Owner User"
    },
    codex: {
      binary: fakeCodexBinary
    },
    permissions: {
      p2pDefaultProfile: "guest"
    },
    profiles: {
      host: { codexHome: path.join(tempDir, "profiles", "host", "codex") },
      guest: { codexHome: path.join(tempDir, "profiles", "guest", "codex") }
    }
  });
}

function createFakeCodexBinary(tempDir: string, traceFile: string, scriptFile: string): string {
  const binary = path.join(tempDir, "fake-codex.mjs");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const traceFile = ${JSON.stringify(traceFile)};
const scriptFile = ${JSON.stringify(scriptFile)};
if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.2.3\\n");
  process.exit(0);
}

const script = fs.readFileSync(scriptFile, "utf8")
  .split(/\\r?\\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const profile = process.env.CODEX_HOME && process.env.CODEX_HOME.includes("/host/") ? "host" : "guest";
const counts = new Map();
const goals = new Map();
const rl = readline.createInterface({ input: process.stdin });

function append(entry) {
  fs.appendFileSync(traceFile, JSON.stringify({ ...entry, at: Date.now() }) + "\\n");
}

function send(message, delayMs = 0) {
  const write = () => {
    append({ kind: "codex.in", profile, message });
    process.stdout.write(JSON.stringify(message) + "\\n");
  };
  if (delayMs > 0) {
    setTimeout(write, delayMs);
    return;
  }
  write();
}

function nextCount(method) {
  const next = (counts.get(method) ?? 0) + 1;
  counts.set(method, next);
  return next;
}

function matches(trigger, message, method, nth) {
  if (!trigger) return false;
  if (trigger.profile && trigger.profile !== profile) return false;
  if (trigger.method && trigger.method !== method) return false;
  if (trigger.nth && trigger.nth !== nth) return false;
  if (trigger.id && trigger.id !== message.id) return false;
  return true;
}

function defaultResult(message, method, nth) {
  if (method === "initialize") {
    return {
      userAgent: "fake-codex",
      codexHome: process.env.CODEX_HOME,
      platformFamily: "unix",
      platformOs: "macos"
    };
  }
  if (method === "thread/start") {
    return { thread: { id: profile + "_thread_" + nth } };
  }
  if (method === "thread/resume") {
    return { thread: { id: message.params.threadId } };
  }
  if (method === "thread/goal/set") {
    const goal = {
      threadId: message.params.threadId,
      objective: message.params.objective ?? "goal",
      status: message.params.status ?? "active",
      tokenBudget: message.params.tokenBudget ?? null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1
    };
    goals.set(message.params.threadId, goal);
    return { goal };
  }
  if (method === "thread/goal/get") {
    return { goal: goals.get(message.params.threadId) ?? null };
  }
  if (method === "thread/goal/clear") {
    const cleared = goals.delete(message.params.threadId);
    return { cleared };
  }
  if (method === "thread/fork") {
    return { thread: { id: profile + "_thread_fork_" + nth, forkedFromId: message.params.threadId } };
  }
  if (method === "turn/start") {
    return { turn: { id: "turn_" + nth } };
  }
  if (method === "thread/compact/start") {
    return {};
  }
  if (method === "turn/steer" || method === "turn/interrupt") {
    return {};
  }
  if (method === "account/rateLimits/read") {
    return { rateLimits: { primary: { usedPercent: 1 } }, rateLimitsByLimitId: null };
  }
  return {};
}

function materialize(value, message) {
  if (typeof value === "string") {
    return value
      .split("{{cwd}}").join(message.params?.cwd ?? "")
      .split("{{threadId}}").join(message.params?.threadId ?? "")
      .split("{{turnId}}").join(message.params?.turnId ?? "");
  }
  if (Array.isArray(value)) {
    return value.map((item) => materialize(item, message));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item, message)]));
  }
  return value;
}

function writeActionFiles(action, message) {
  for (const file of action.files ?? []) {
    const filePath = materialize(file.path, message);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content ?? "");
  }
}

function emitAction(action, message) {
  writeActionFiles(action, message);
  if (action.notify) {
    send({ method: action.notify.method, params: materialize(action.notify.params, message) }, action.delayMs ?? 0);
  }
  if (action.request) {
    send({ id: action.request.id, method: action.request.method, params: materialize(action.request.params, message) }, action.delayMs ?? 0);
  }
}

function emitDefaultGoalCompletion(message) {
  const threadId = message.params.threadId;
  send({ method: "turn/started", params: { threadId, turn: { id: "goal_turn_1" } } });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId: "goal_turn_1",
      item: { type: "agentMessage", id: "goal_msg_1", text: "goal progress", phase: "commentary" },
      completedAtMs: Date.now()
    }
  });
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: "goal_turn_1",
        status: "completed",
        durationMs: 5,
        items: [{ type: "agentMessage", id: "goal_msg_2", text: "goal complete", phase: "final_answer" }]
      }
    }
  });
  const current = goals.get(threadId);
  if (!current) return;
  const completed = { ...current, status: "complete", updatedAt: 2 };
  goals.set(threadId, completed);
  send({ method: "thread/goal/updated", params: { threadId, turnId: "goal_turn_1", goal: completed } });
}

function handleRequest(message) {
  const method = message.method;
  const nth = nextCount(method);
  const custom = script.find((action) => matches(action.on, message, method, nth));
  if (custom?.error) {
    send({ id: message.id, error: custom.error });
  } else {
    send({ id: message.id, result: custom?.reply ?? defaultResult(message, method, nth) });
  }
  if (!custom && method === "thread/goal/set") {
    emitDefaultGoalCompletion(message);
  }
  if (!custom && method === "thread/goal/clear") {
    send({ method: "thread/goal/cleared", params: { threadId: message.params.threadId } });
  }
  for (const action of script) {
    if (matches(action.after, message, method, nth)) {
      emitAction(action, message);
    }
  }
}

function handleResponse(message) {
  const key = "response:" + String(message.id);
  const nth = nextCount(key);
  for (const action of script) {
    if (matches(action.afterResponse, message, key, nth)) {
      emitAction(action, message);
    }
  }
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  append({ kind: "codex.out", profile, id: message.id, method: message.method ?? null, message });
  if (message.method && message.id !== undefined) {
    handleRequest(message);
    return;
  }
  if (!message.method && message.id !== undefined) {
    handleResponse(message);
  }
});
`,
    { mode: 0o755 }
  );
  return binary;
}

function receiveMessageEvent(options: {
  eventId: string;
  messageId: string;
  text?: string;
  messageType?: string;
  content?: unknown;
  senderOpenId?: string;
  senderName?: string;
  chatType?: "p2p" | "group" | "topic_group";
  chatId?: string;
  threadId?: string;
  rootId?: string;
  parentId?: string;
  mentions?: Array<Record<string, unknown>>;
}): unknown {
  const senderOpenId = options.senderOpenId ?? "ou_guest";
  const chatType = options.chatType ?? "p2p";
  const messageType = options.messageType ?? "text";
  const content = options.content ?? JSON.stringify({ text: options.text ?? "" });
  return {
    event_id: options.eventId,
    sender: {
      sender_id: {
        open_id: senderOpenId
      },
      sender_type: "user",
      sender_name: options.senderName ?? userNameForOpenId(senderOpenId)
    },
    message: {
      message_id: options.messageId,
      root_id: options.rootId,
      parent_id: options.parentId,
      thread_id: options.threadId,
      create_time: "1000",
      chat_id: options.chatId ?? (chatType === "p2p" ? senderOpenId : "oc_group"),
      chat_type: chatType,
      message_type: messageType,
      mentions: options.mentions,
      content
    }
  };
}

function userNameForOpenId(openId: string): string {
  if (openId === "ou_owner") {
    return "Owner User";
  }
  if (openId === "ou_other") {
    return "Other User";
  }
  return "Guest User";
}

function recallEvent(options: { eventId: string; messageId: string }): unknown {
  return {
    header: { event_id: options.eventId },
    event: {
      message_id: options.messageId,
      chat_id: "oc_ignored",
      recall_time: "1100"
    }
  };
}

function cardActionEvent(options: {
  eventId: string;
  action: string;
  stateKey: string;
  runId: number;
  formValue?: Record<string, unknown>;
  operatorOpenId?: string;
  openMessageId?: string;
  openChatId?: string;
}): unknown {
  return {
    header: { event_id: options.eventId },
    event: {
      operator: { open_id: options.operatorOpenId ?? "ou_guest" },
      open_message_id: options.openMessageId,
      open_chat_id: options.openChatId,
      action: {
        tag: "button",
        value: {
          twinny: true,
          action: options.action,
          stateKey: options.stateKey,
          runId: options.runId
        },
        form_value: options.formValue ?? {}
      }
    }
  };
}

function botMention(): Record<string, unknown> {
  return {
    key: "@_bot",
    id: {
      open_id: "ou_bot"
    },
    name: "Twinny"
  };
}

function parseJsonl<T>(jsonl: string): T[] {
  return normalizeJsonl(jsonl)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function jsonl(...items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n");
}

function normalizeJsonl(jsonl: string): string {
  return jsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function appendTrace(traceFile: string, entry: Record<string, unknown>): void {
  fs.appendFileSync(traceFile, `${JSON.stringify({ ...entry, at: Date.now() })}\n`, "utf8");
}

async function parseRequestBody(body: string | FormData | undefined): Promise<unknown> {
  if (typeof body !== "string") {
    if (body === undefined) {
      return undefined;
    }
    return parseFormData(body);
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function parseFormData(body: FormData): unknown {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of body.entries()) {
    fields[key] = typeof value === "string" ? value : {
      name: "name" in value ? value.name : undefined,
      size: "size" in value ? value.size : undefined,
      type: "type" in value ? value.type : undefined
    };
  }
  return { formData: fields };
}

function parseBodyContent(body: unknown): unknown {
  const record = asRecord(body);
  if (!record || typeof record.content !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(record.content);
  } catch {
    return record.content;
  }
}

function eventMessage(raw: unknown): Record<string, unknown> | undefined {
  const root = asRecord(raw);
  const event = asRecord(root?.event) ?? root;
  return asRecord(event?.message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)).buffer
  };
}

function binaryResponse(body: Buffer, contentType: string, contentDisposition?: string): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get(name: string) {
        const normalized = name.toLowerCase();
        if (normalized === "content-type") {
          return contentType;
        }
        if (normalized === "content-disposition") {
          return contentDisposition ?? null;
        }
        return null;
      }
    },
    json: async () => ({}),
    text: async () => body.toString("utf8"),
    arrayBuffer: async () => new Uint8Array(body).buffer
  };
}

function codexOut(trace: TraceEntry[], method: string): CodexTraceEntry[] {
  return trace.filter((entry): entry is CodexTraceEntry => isCodexMethod(entry, method));
}

function codexResponses(trace: TraceEntry[], id: string): CodexTraceEntry[] {
  return trace.filter((entry): entry is CodexTraceEntry => isCodexResponse(entry, id));
}

function codexErrorNotifications(trace: TraceEntry[]): CodexIncomingTraceEntry[] {
  return trace.filter((entry): entry is CodexIncomingTraceEntry => entry.kind === "codex.in" && entry.message.method === "error");
}

function codexErrorWillRetry(entry: CodexIncomingTraceEntry): unknown {
  return asRecord(entry.message.params)?.willRetry;
}

function larkOut(trace: TraceEntry[]): LarkTraceEntry[] {
  return trace.filter((entry): entry is LarkTraceEntry => entry.kind === "lark.out");
}

function isCodexMethod(entry: TraceEntry, method: string): entry is CodexTraceEntry {
  return entry.kind === "codex.out" && entry.method === method;
}

function isCodexRetryableError(entry: TraceEntry): boolean {
  return entry.kind === "codex.in" && entry.message.method === "error" && asRecord(entry.message.params)?.willRetry === true;
}

function isCodexTerminalError(entry: TraceEntry): boolean {
  return entry.kind === "codex.in" && entry.message.method === "error" && asRecord(entry.message.params)?.willRetry === false;
}

function isCodexResponse(entry: TraceEntry, id: string): entry is CodexTraceEntry {
  return entry.kind === "codex.out" && entry.id === id && entry.method === null;
}

function isLarkRequest(entry: TraceEntry, method: string, path: string): entry is LarkTraceEntry {
  return entry.kind === "lark.out" && entry.method === method && entry.path === path;
}

function traceText(entry: TraceEntry | undefined): string {
  return JSON.stringify(entry ?? {});
}

function expectOrder(
  trace: TraceEntry[],
  checkpoints: Array<[string, (entry: TraceEntry, index: number, all: TraceEntry[]) => boolean]>
): void {
  let cursor = -1;
  for (const [label, predicate] of checkpoints) {
    const index = trace.findIndex((entry, itemIndex) => itemIndex > cursor && predicate(entry, itemIndex, trace));
    expect(index, label).toBeGreaterThan(cursor);
    cursor = index;
  }
}

function waitForDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function silentLogger(): ConstructorParameters<typeof ConversationManager>[0]["logger"] {
  return ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  } as unknown) as ConstructorParameters<typeof ConversationManager>[0]["logger"];
}

interface LarkEventInput {
  atMs?: number;
  event: string;
  data: unknown;
}

type TraceEntry = CodexTraceEntry | CodexIncomingTraceEntry | LarkTraceEntry;

interface CodexTraceEntry {
  kind: "codex.out";
  at: number;
  profile: ProfileName;
  id: string | number;
  method: string | null;
  message: {
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };
}

interface CodexIncomingTraceEntry {
  kind: "codex.in";
  at: number;
  profile: ProfileName;
  message: {
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };
}

interface LarkTraceEntry {
  kind: "lark.out";
  at: number;
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  bodyContentJson?: unknown;
}
