import type { CodexThreadNameUpdate } from "../types.js";
import type { CodexNotificationMessage } from "./protocol.js";

export function parseCodexThreadNameUpdatedNotification(
  message: CodexNotificationMessage
): CodexThreadNameUpdate | undefined {
  if (message.method !== "thread/name/updated" || !isRecord(message.params)) {
    return undefined;
  }
  const threadId = firstString(message.params.threadId, message.params.thread_id);
  const name = firstString(message.params.name, message.params.threadName, message.params.thread_name);
  if (!threadId || !name) {
    return undefined;
  }
  return { threadId, name };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
