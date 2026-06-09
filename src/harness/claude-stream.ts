import type { CodexThreadTokenUsageUpdate } from "../types.js";

/**
 * Pure parsing helpers for the Claude Code CLI stream-json protocol
 * (`claude -p --input-format stream-json --output-format stream-json --verbose`).
 *
 * Kept side-effect free so the protocol mapping can be unit tested without
 * spawning processes.
 */

export interface ClaudeUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

export interface ClaudeInitEvent {
  kind: "init";
  sessionId: string;
  model?: string;
}

export interface ClaudeAssistantEvent {
  kind: "assistant";
  messageId?: string;
  text: string;
  hasToolUse: boolean;
  usage?: ClaudeUsage;
}

export interface ClaudeResultEvent {
  kind: "result";
  subtype: string;
  isError: boolean;
  sessionId?: string;
  text?: string;
  usage?: ClaudeUsage;
  durationMs?: number;
  contextWindow?: number;
}

export interface ClaudeOtherEvent {
  kind: "other";
  raw: unknown;
}

export type ClaudeStreamEvent = ClaudeInitEvent | ClaudeAssistantEvent | ClaudeResultEvent | ClaudeOtherEvent;

export function parseClaudeStreamLine(line: string): ClaudeStreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) {
    return undefined;
  }

  if (raw.type === "system" && raw.subtype === "init") {
    const sessionId = stringValue(raw.session_id);
    if (!sessionId) {
      return { kind: "other", raw };
    }
    return {
      kind: "init",
      sessionId,
      ...(stringValue(raw.model) ? { model: stringValue(raw.model) } : {})
    };
  }

  if (raw.type === "assistant" && isRecord(raw.message)) {
    const message = raw.message;
    const content = Array.isArray(message.content) ? message.content : [];
    const textParts: string[] = [];
    let hasToolUse = false;
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        hasToolUse = true;
      }
    }
    const usage = parseClaudeUsage(message.usage);
    return {
      kind: "assistant",
      ...(stringValue(message.id) ? { messageId: stringValue(message.id) } : {}),
      text: textParts.join("\n").trim(),
      hasToolUse,
      ...(usage ? { usage } : {})
    };
  }

  if (raw.type === "result") {
    const usage = parseClaudeUsage(raw.usage);
    const contextWindow = extractContextWindow(raw.modelUsage);
    return {
      kind: "result",
      subtype: stringValue(raw.subtype) ?? "unknown",
      isError: raw.is_error === true,
      ...(stringValue(raw.session_id) ? { sessionId: stringValue(raw.session_id) } : {}),
      ...(typeof raw.result === "string" ? { text: raw.result } : {}),
      ...(usage ? { usage } : {}),
      ...(finiteNumber(raw.duration_ms) !== undefined ? { durationMs: finiteNumber(raw.duration_ms) } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {})
    };
  }

  return { kind: "other", raw };
}

export function parseClaudeUsage(value: unknown): ClaudeUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputTokens = finiteNumber(value.input_tokens);
  const outputTokens = finiteNumber(value.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens: inputTokens ?? 0,
    cacheCreationInputTokens: finiteNumber(value.cache_creation_input_tokens) ?? 0,
    cacheReadInputTokens: finiteNumber(value.cache_read_input_tokens) ?? 0,
    outputTokens: outputTokens ?? 0
  };
}

export function emptyClaudeUsage(): ClaudeUsage {
  return { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
}

export function addClaudeUsage(left: ClaudeUsage, right: ClaudeUsage): ClaudeUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    outputTokens: left.outputTokens + right.outputTokens
  };
}

export function claudeUsageTotalTokens(usage: ClaudeUsage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens + usage.outputTokens;
}

/**
 * Shapes a Claude usage snapshot like the Codex `thread/tokenUsage/updated`
 * payload so the conversation manager can reuse its existing extraction
 * logic. Token semantics mapping:
 *  - inputTokens: all prompt tokens (incl. cache writes/reads, matching the
 *    Codex convention that cached tokens are part of input)
 *  - cachedInputTokens: cache read tokens
 *  - reasoningOutputTokens: 0 (Claude Code does not report a separate
 *    reasoning token count)
 */
export function claudeUsageToTokenUsageUpdate(params: {
  threadId: string;
  turnId?: string;
  cumulative: ClaudeUsage;
  lastTurn?: ClaudeUsage;
  contextTokens?: number;
  contextWindow?: number;
}): CodexThreadTokenUsageUpdate {
  const total = claudeUsageToCodexTotals(params.cumulative);
  const last = params.lastTurn ? claudeUsageToCodexTotals(params.lastTurn) : undefined;
  return {
    threadId: params.threadId,
    ...(params.turnId ? { turnId: params.turnId } : {}),
    totalTokens: total.totalTokens,
    raw: {
      threadId: params.threadId,
      ...(params.turnId ? { turnId: params.turnId } : {}),
      tokenUsage: {
        total,
        ...(last ? { last } : {}),
        ...(params.contextTokens !== undefined ? { contextTokens: params.contextTokens } : {}),
        ...(params.contextWindow !== undefined ? { modelContextWindow: params.contextWindow } : {})
      }
    }
  };
}

function claudeUsageToCodexTotals(usage: ClaudeUsage): {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
} {
  return {
    totalTokens: claudeUsageTotalTokens(usage),
    inputTokens: usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens,
    cachedInputTokens: usage.cacheReadInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: 0
  };
}

function extractContextWindow(modelUsage: unknown): number | undefined {
  if (!isRecord(modelUsage)) {
    return undefined;
  }
  let max: number | undefined;
  for (const entry of Object.values(modelUsage)) {
    if (!isRecord(entry)) {
      continue;
    }
    const window = finiteNumber(entry.contextWindow);
    if (window !== undefined && (max === undefined || window > max)) {
      max = window;
    }
  }
  return max;
}

export function buildClaudeUserMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }]
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
