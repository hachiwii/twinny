import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexProtocolClient } from "./protocol.js";
import {
  buildTurnInterruptParams,
  buildTurnStartParams,
  buildTurnSteerParams,
  startCodexTurn,
  TurnOutputAccumulator
} from "./turn.js";

describe("codex turn payloads", () => {
  it("builds turn/start text input with minimal Twinny runtime overrides", () => {
    expect(
      buildTurnStartParams({
        threadId: "thread_123",
        text: "hello",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1"
      })
    ).toEqual({
      threadId: "thread_123",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      cwd: "/tmp/twinny/workspaces/p2p_ou_1",
      approvalPolicy: "never"
    });
  });

  it("builds turn/steer text input with the active turn precondition", () => {
    expect(
      buildTurnSteerParams({
        threadId: "thread_123",
        turnId: "turn_1",
        text: "steer this turn"
      })
    ).toEqual({
      threadId: "thread_123",
      input: [{ type: "text", text: "steer this turn", text_elements: [] }],
      expectedTurnId: "turn_1"
    });
  });

  it("builds turn/interrupt params", () => {
    expect(buildTurnInterruptParams({ threadId: "thread_123", turnId: "turn_1" })).toEqual({
      threadId: "thread_123",
      turnId: "turn_1"
    });
  });
});

describe("TurnOutputAccumulator", () => {
  it("aggregates assistant text from item/completed and turn/completed notifications", async () => {
    const accumulator = new TurnOutputAccumulator("thread_123");

    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "turn_1" }
      }
    });
    accumulator.record({
      method: "item/completed",
      params: {
        threadId: "thread_123",
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "first" }
      }
    });
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "turn_1",
          status: "completed",
          durationMs: 42,
          items: [
            { type: "agentMessage", id: "msg_1", text: "first" },
            { type: "agentMessage", id: "msg_2", text: "second" }
          ]
        }
      }
    });

    await expect(accumulator.wait()).resolves.toEqual({
      threadId: "thread_123",
      turnId: "turn_1",
      text: "first\n\nsecond",
      status: "completed",
      error: undefined,
      durationMs: 42
    });
  });

  it("emits completed agentMessage items without replaying turn/completed items", async () => {
    const messages: Array<{ id: string; text: string }> = [];
    const accumulator = new TurnOutputAccumulator("thread_123", undefined, {
      onAgentMessage: (message) => {
        messages.push(message);
      }
    });

    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "turn_1" }
      }
    });
    accumulator.record({
      method: "item/completed",
      params: {
        threadId: "thread_123",
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "first" }
      }
    });
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "turn_1",
          status: "completed",
          items: [
            { type: "agentMessage", id: "msg_1", text: "first" },
            { type: "agentMessage", id: "msg_2", text: "finish-only" }
          ]
        }
      }
    });

    await accumulator.wait();

    expect(messages).toEqual([{ id: "msg_1", text: "first" }]);
  });

  it("preserves agentMessage phase and prefers final answer text in turn results", async () => {
    const messages: Array<{ id: string; text: string; phase?: "commentary" | "final_answer" | null }> = [];
    const accumulator = new TurnOutputAccumulator("thread_123", undefined, {
      onAgentMessage: (message) => {
        messages.push(message);
      }
    });

    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "turn_1" }
      }
    });
    accumulator.record({
      method: "item/completed",
      params: {
        threadId: "thread_123",
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "working", phase: "commentary" }
      }
    });
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "turn_1",
          status: "completed",
          items: [
            { type: "agentMessage", id: "msg_1", text: "working", phase: "commentary" },
            { type: "agentMessage", id: "msg_2", text: "final result", phase: "final_answer" }
          ]
        }
      }
    });

    await expect(accumulator.wait()).resolves.toMatchObject({
      threadId: "thread_123",
      turnId: "turn_1",
      text: "final result",
      status: "completed"
    });
    expect(messages).toEqual([{ id: "msg_1", text: "working", phase: "commentary" }]);
  });

  it("reports interrupted turn status and emits turn-started once", async () => {
    const turnStarted = vi.fn();
    const accumulator = new TurnOutputAccumulator("thread_123", undefined, {
      onTurnStarted: turnStarted
    });

    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "turn_1" }
      }
    });
    accumulator.setTurnId("turn_1");
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "turn_1",
          status: "interrupted",
          items: []
        }
      }
    });

    await expect(accumulator.wait()).resolves.toMatchObject({
      threadId: "thread_123",
      turnId: "turn_1",
      status: "interrupted"
    });
    expect(turnStarted).toHaveBeenCalledTimes(1);
    expect(turnStarted).toHaveBeenCalledWith("turn_1");
  });

  it("emits thread token usage updates", async () => {
    const tokenUsage = vi.fn();
    const accumulator = new TurnOutputAccumulator("thread_123", undefined, {
      onTokenUsage: tokenUsage
    });

    accumulator.record({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread_123",
        turnId: "turn_1",
        usage: {
          total: {
            totalTokens: 99
          }
        }
      }
    });

    expect(tokenUsage).toHaveBeenCalledWith({
      threadId: "thread_123",
      turnId: "turn_1",
      totalTokens: 99,
      raw: {
        threadId: "thread_123",
        turnId: "turn_1",
        usage: {
          total: {
            totalTokens: 99
          }
        }
      }
    });
  });
});

describe("startCodexTurn", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses request timeout for turn/start without timing out normal long-running turns", async () => {
    vi.useFakeTimers();
    const protocol = new FakeProtocol();
    protocol.requestMock.mockImplementationOnce(async () => {
      setTimeout(() => {
        protocol.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread_123",
            turn: {
              id: "turn_1",
              status: "completed",
              items: [{ type: "agentMessage", id: "msg_1", text: "done" }]
            }
          }
        });
      }, 10);
      return { turn: { id: "turn_1" } };
    });

    const result = startCodexTurn(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work longer than the request timeout",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1"
      },
      { requestTimeoutMs: 5 }
    );

    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toMatchObject({
      threadId: "thread_123",
      turnId: "turn_1",
      text: "done",
      status: "completed"
    });
    expect(protocol.requestMock).toHaveBeenCalledWith(
      "turn/start",
      expect.any(Object),
      { timeoutMs: 5 }
    );
  });
});

class FakeProtocol extends EventEmitter {
  readonly requestMock = vi.fn();

  request<TResult = unknown>(...args: unknown[]): Promise<TResult> {
    return this.requestMock(...args) as Promise<TResult>;
  }
}
