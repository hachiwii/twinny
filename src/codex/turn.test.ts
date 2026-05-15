import { describe, expect, it } from "vitest";
import { buildTurnStartParams, TurnOutputAccumulator } from "./turn.js";

describe("codex turn payloads", () => {
  it("builds turn/start text input with minimal Twinny runtime overrides", () => {
    expect(
      buildTurnStartParams({
        threadId: "thread_123",
        text: "hello",
        cwd: "/tmp/twinny/workspaces/p2p:ou_1"
      })
    ).toEqual({
      threadId: "thread_123",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      cwd: "/tmp/twinny/workspaces/p2p:ou_1",
      approvalPolicy: "never"
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
});
