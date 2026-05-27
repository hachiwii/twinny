import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CodexProtocolClient } from "./protocol.js";
import { runCodexThreadGoal, type ThreadGoal } from "./goal.js";

class FakeGoalProtocol extends EventEmitter {
  readonly requests: Array<{ method: string; params: unknown }> = [];

  async request<TResult = unknown, TParams = unknown>(method: string, params?: TParams): Promise<TResult> {
    this.requests.push({ method, params });
    if (method === "thread/goal/set") {
      return {
        goal: goal({
          threadId: "thread_1",
          objective: "calculate pi",
          status: "active"
        })
      } as TResult;
    }
    throw new Error(`Unexpected request: ${method}`);
  }
}

describe("runCodexThreadGoal", () => {
  it("waits for the current turn final answer when a terminal goal update has no turn id", async () => {
    const protocol = new FakeGoalProtocol();
    const resultPromise = runCodexThreadGoal(
      protocol as unknown as CodexProtocolClient,
      { threadId: "thread_1", cwd: "/tmp/twinny/workspaces/p2p_ou_1", objective: "calculate pi" },
      { completionTimeoutMs: 1_000 }
    );

    await Promise.resolve();
    expect(protocol.requests.map((request) => request.method)).toEqual(["thread/goal/set"]);

    protocol.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread_1", turn: { id: "turn_1" } }
    });
    protocol.emit("notification", {
      method: "thread/goal/updated",
      params: {
        threadId: "thread_1",
        goal: goal({
          threadId: "thread_1",
          objective: "calculate pi",
          status: "complete"
        })
      }
    });
    protocol.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        item: { type: "agentMessage", id: "final_1", text: "3.14159", phase: "final_answer" }
      }
    });
    protocol.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: {
          id: "turn_1",
          status: "completed",
          durationMs: 1,
          items: [{ type: "agentMessage", id: "final_1", text: "3.14159", phase: "final_answer" }]
        }
      }
    });

    await expect(resultPromise).resolves.toMatchObject({
      status: "completed",
      text: "3.14159"
    });
  });

  it("ignores Codex errors from another thread while a goal is active", async () => {
    const protocol = new FakeGoalProtocol();
    const resultPromise = runCodexThreadGoal(
      protocol as unknown as CodexProtocolClient,
      { threadId: "thread_1", cwd: "/tmp/twinny/workspaces/p2p_ou_1", objective: "calculate pi" },
      { completionTimeoutMs: 1_000 }
    );

    await Promise.resolve();
    protocol.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread_1", turn: { id: "turn_1" } }
    });
    protocol.emit("notification", {
      method: "error",
      params: {
        threadId: "thread_other",
        turnId: "turn_other",
        message: "other thread failed",
        willRetry: false
      }
    });
    protocol.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        item: { type: "agentMessage", id: "final_1", text: "3.14159", phase: "final_answer" }
      }
    });
    protocol.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: {
          id: "turn_1",
          status: "completed",
          durationMs: 1,
          items: [{ type: "agentMessage", id: "final_1", text: "3.14159", phase: "final_answer" }]
        }
      }
    });
    protocol.emit("notification", {
      method: "thread/goal/updated",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        goal: goal({
          threadId: "thread_1",
          objective: "calculate pi",
          status: "complete"
        })
      }
    });

    await expect(resultPromise).resolves.toMatchObject({
      status: "completed",
      text: "3.14159"
    });
  });

  it("keeps waiting when Codex reports a retryable goal turn error", async () => {
    const protocol = new FakeGoalProtocol();
    const codexError = vi.fn();
    const resultPromise = runCodexThreadGoal(
      protocol as unknown as CodexProtocolClient,
      { threadId: "thread_1", cwd: "/tmp/twinny/workspaces/p2p_ou_1", objective: "calculate pi", onCodexError: codexError },
      { completionTimeoutMs: 1_000 }
    );

    await Promise.resolve();
    protocol.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread_1", turn: { id: "turn_1" } }
    });
    protocol.emit("notification", {
      method: "error",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        error: {
          message: "Reconnecting... 2/5",
          codexErrorInfo: {
            responseStreamDisconnected: {
              httpStatusCode: null
            }
          }
        },
        additionalDetails: "request timed out",
        willRetry: true
      }
    });
    protocol.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        item: { type: "agentMessage", id: "final_1", text: "3.14159", phase: "final_answer" }
      }
    });
    protocol.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: {
          id: "turn_1",
          status: "completed",
          durationMs: 1,
          items: [{ type: "agentMessage", id: "final_1", text: "3.14159", phase: "final_answer" }]
        }
      }
    });
    protocol.emit("notification", {
      method: "thread/goal/updated",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        goal: goal({
          threadId: "thread_1",
          objective: "calculate pi",
          status: "complete"
        })
      }
    });

    await expect(resultPromise).resolves.toMatchObject({
      status: "completed",
      text: "3.14159"
    });
    expect(codexError).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread_1",
      turnId: "turn_1",
      message: "Reconnecting... 2/5",
      willRetry: true,
      codexErrorInfo: "responseStreamDisconnected",
      additionalDetails: "request timed out"
    }));
  });

  it("fails with the nested Codex error message for non-retryable goal errors", async () => {
    const protocol = new FakeGoalProtocol();
    const resultPromise = runCodexThreadGoal(
      protocol as unknown as CodexProtocolClient,
      { threadId: "thread_1", cwd: "/tmp/twinny/workspaces/p2p_ou_1", objective: "calculate pi" },
      { completionTimeoutMs: 1_000 }
    );

    await Promise.resolve();
    protocol.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread_1", turn: { id: "turn_1" } }
    });
    protocol.emit("notification", {
      method: "error",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        error: { message: "terminal stream failure" },
        additionalDetails: "request timed out",
        willRetry: false
      }
    });

    await expect(resultPromise).rejects.toMatchObject({
      code: "CODEX_THREAD_GOAL_FAILED",
      message: "terminal stream failure"
    });
  });
});

function goal(values: Pick<ThreadGoal, "threadId" | "objective" | "status">): ThreadGoal {
  return {
    ...values,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1
  };
}
