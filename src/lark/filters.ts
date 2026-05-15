import type { IncomingLarkMessage } from "../types.js";

export interface RawLarkMessageReceiveEvent {
  event_id?: string;
  uuid?: string;
  create_time?: string;
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    name?: string;
    sender_name?: string;
    display_name?: string;
    sender_display_name?: string;
    sender_type?: string;
    tenant_key?: string;
  };
  message?: {
    message_id?: string;
    create_time?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: unknown;
  };
}

export type LarkMessageIgnoreReason =
  | "malformed_event"
  | "missing_sender_open_id"
  | "bot_self_message"
  | "non_p2p_message"
  | "non_text_message"
  | "missing_message_id"
  | "empty_text";

export interface NormalizeLarkMessageOptions {
  botOpenId?: string;
}

export type NormalizeLarkMessageResult =
  | { kind: "message"; message: IncomingLarkMessage }
  | { kind: "ignored"; reason: LarkMessageIgnoreReason; raw: unknown };

export function normalizeIncomingLarkMessage(
  raw: unknown,
  options: NormalizeLarkMessageOptions = {}
): IncomingLarkMessage | null {
  const result = normalizeIncomingLarkMessageWithReason(raw, options);
  return result.kind === "message" ? result.message : null;
}

export function normalizeIncomingLarkMessageWithReason(
  raw: unknown,
  options: NormalizeLarkMessageOptions = {}
): NormalizeLarkMessageResult {
  if (!isRecord(raw) || !isRecord(raw.sender) || !isRecord(raw.message)) {
    return ignored("malformed_event", raw);
  }

  const sender = raw.sender;
  const senderId = isRecord(sender.sender_id) ? sender.sender_id : {};
  const senderOpenId = stringValue(senderId.open_id);
  if (!senderOpenId) {
    return ignored("missing_sender_open_id", raw);
  }

  const senderType = stringValue(sender.sender_type)?.toLowerCase();
  if (senderType === "app" || senderType === "bot" || senderOpenId === options.botOpenId) {
    return ignored("bot_self_message", raw);
  }
  const senderName = firstStringValue(
    sender.name,
    sender.sender_name,
    sender.display_name,
    sender.sender_display_name
  );

  const message = raw.message;
  if (!isP2pChatType(stringValue(message.chat_type))) {
    return ignored("non_p2p_message", raw);
  }

  const messageType = stringValue(message.message_type);
  if (messageType !== "text") {
    return ignored("non_text_message", raw);
  }

  const messageId = stringValue(message.message_id);
  if (!messageId) {
    return ignored("missing_message_id", raw);
  }

  const text = normalizeTextContent(message.content);
  if (text === null || text.length === 0) {
    return ignored("empty_text", raw);
  }

  return {
    kind: "message",
    message: {
      eventId: stringValue(raw.event_id) ?? stringValue(raw.uuid) ?? messageId,
      messageId,
      chatId: senderOpenId,
      chatType: "p2p",
      messageType,
      senderOpenId,
      senderName,
      text,
      createTime: parseEpochMs(message.create_time ?? raw.create_time),
      raw
    }
  };
}

export function normalizeTextContent(content: unknown): string | null {
  if (typeof content !== "string") {
    if (isRecord(content) && typeof content.text === "string") {
      return content.text;
    }
    return null;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && typeof parsed.text === "string") {
      return parsed.text;
    }
  } catch {
    // Some event sources emit already-decoded text; raw SDK events emit JSON strings.
  }
  return content;
}

function isP2pChatType(chatType: string | undefined): boolean {
  if (!chatType) {
    return false;
  }
  return ["p2p", "p2p_chat", "private", "private_chat"].includes(chatType.toLowerCase());
}

function parseEpochMs(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function ignored(reason: LarkMessageIgnoreReason, raw: unknown): NormalizeLarkMessageResult {
  return { kind: "ignored", reason, raw };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    const string = stringValue(value);
    if (string) {
      return string;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
