import { describe, expect, it } from "vitest";
import {
  addClaudeUsage,
  buildClaudeUserMessage,
  claudeUsageToTokenUsageUpdate,
  claudeUsageTotalTokens,
  emptyClaudeUsage,
  parseClaudeStreamLine
} from "./claude-stream.js";

describe("parseClaudeStreamLine", () => {
  it("parses system init events", () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "11111111-2222-3333-4444-555555555555",
        model: "claude-sonnet-4-6",
        cwd: "/tmp"
      })
    );
    expect(event).toEqual({
      kind: "init",
      sessionId: "11111111-2222-3333-4444-555555555555",
      model: "claude-sonnet-4-6"
    });
  });

  it("parses assistant text and tool_use blocks", () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            { type: "text", text: "先看一下仓库结构" },
            { type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls" } }
          ],
          usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 }
        },
        session_id: "s1"
      })
    );
    expect(event).toEqual({
      kind: "assistant",
      messageId: "msg_1",
      text: "先看一下仓库结构",
      hasToolUse: true,
      usage: { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 5, outputTokens: 7 }
    });
  });

  it("parses result events including modelUsage context window", () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "最终回答",
        session_id: "s1",
        duration_ms: 1234,
        usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 },
        modelUsage: { "claude-sonnet-4-6": { inputTokens: 100, contextWindow: 200000 } }
      })
    );
    expect(event).toEqual({
      kind: "result",
      subtype: "success",
      isError: false,
      sessionId: "s1",
      text: "最终回答",
      usage: { inputTokens: 100, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 40 },
      durationMs: 1234,
      contextWindow: 200000
    });
  });

  it("parses error results without a result text", () => {
    const event = parseClaudeStreamLine(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" })
    );
    expect(event).toMatchObject({ kind: "result", subtype: "error_during_execution", isError: true });
  });

  it("ignores blank and non-JSON lines", () => {
    expect(parseClaudeStreamLine("")).toBeUndefined();
    expect(parseClaudeStreamLine("not json")).toBeUndefined();
  });

  it("passes through unknown event types", () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: "user", message: {} }))).toMatchObject({ kind: "other" });
  });
});

describe("claude usage mapping", () => {
  it("accumulates usage and computes totals", () => {
    const total = addClaudeUsage(emptyClaudeUsage(), {
      inputTokens: 10,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
      outputTokens: 4
    });
    expect(claudeUsageTotalTokens(total)).toBe(19);
  });

  it("shapes token usage updates like Codex thread token usage payloads", () => {
    const update = claudeUsageToTokenUsageUpdate({
      threadId: "thread_1",
      turnId: "turn_1",
      cumulative: { inputTokens: 100, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 40 },
      lastTurn: { inputTokens: 10, cacheCreationInputTokens: 2, cacheReadInputTokens: 3, outputTokens: 4 },
      contextTokens: 150,
      contextWindow: 200000
    });
    expect(update.threadId).toBe("thread_1");
    expect(update.turnId).toBe("turn_1");
    expect(update.totalTokens).toBe(190);
    expect(update.raw).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
      tokenUsage: {
        total: {
          totalTokens: 190,
          inputTokens: 150,
          cachedInputTokens: 30,
          outputTokens: 40,
          reasoningOutputTokens: 0
        },
        last: {
          totalTokens: 19,
          inputTokens: 15,
          cachedInputTokens: 3,
          outputTokens: 4,
          reasoningOutputTokens: 0
        },
        contextTokens: 150,
        modelContextWindow: 200000
      }
    });
  });
});

describe("buildClaudeUserMessage", () => {
  it("builds stream-json user messages", () => {
    expect(JSON.parse(buildClaudeUserMessage("你好"))).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "你好" }] }
    });
  });
});
