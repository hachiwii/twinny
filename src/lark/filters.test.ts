import { describe, expect, it } from "vitest";
import { normalizeIncomingLarkMessage, normalizeIncomingLarkMessageWithReason, normalizeTextContent } from "./filters.js";

describe("normalizeTextContent", () => {
  it("accepts raw text and JSON text payloads", () => {
    expect(normalizeTextContent("plain text")).toBe("plain text");
    expect(normalizeTextContent(JSON.stringify({ text: "json text" }))).toBe("json text");
    expect(normalizeTextContent({ text: "object text" })).toBe("object text");
  });
});

describe("normalizeIncomingLarkMessage", () => {
  it("normalizes p2p text events using sender open_id as chatId", () => {
    const normalized = normalizeIncomingLarkMessage(receiveEvent());

    expect(normalized).toMatchObject({
      eventId: "event-1",
      messageId: "om_1",
      chatId: "ou_user",
      chatType: "p2p",
      messageType: "text",
      senderOpenId: "ou_user",
      senderName: "User Name",
      text: "hello",
      createTime: 1234
    });
  });

  it("normalizes p2p image events as downloadable resources", () => {
    const normalized = normalizeIncomingLarkMessage(
      receiveEvent({
        message: {
          message_type: "image",
          content: JSON.stringify({ image_key: "img_123" })
        }
      })
    );

    expect(normalized).toMatchObject({
      messageId: "om_1",
      messageType: "image",
      text: "收到一个文件，资源 key：img_123",
      resources: [{ resourceType: "image", fileKey: "img_123" }]
    });
  });

  it("ignores group, unsupported, and bot-self messages", () => {
    expect(normalizeIncomingLarkMessageWithReason(receiveEvent({ message: { chat_type: "group" } }))).toMatchObject({
      kind: "ignored",
      reason: "non_p2p_message"
    });
    expect(normalizeIncomingLarkMessageWithReason(receiveEvent({ message: { message_type: "sticker" } }))).toMatchObject({
      kind: "ignored",
      reason: "unsupported_message_type"
    });
    expect(normalizeIncomingLarkMessageWithReason(receiveEvent({ sender: { sender_type: "app" } }))).toMatchObject({
      kind: "ignored",
      reason: "bot_self_message"
    });
    expect(normalizeIncomingLarkMessageWithReason(receiveEvent(), { botOpenId: "ou_user" })).toMatchObject({
      kind: "ignored",
      reason: "bot_self_message"
    });
  });
});

function receiveEvent(overrides: { sender?: Record<string, unknown>; message?: Record<string, unknown> } = {}) {
  return {
    event_id: "event-1",
    sender: {
      sender_id: {
        open_id: "ou_user"
      },
      name: "User Name",
      sender_type: "user",
      ...overrides.sender
    },
    message: {
      message_id: "om_1",
      create_time: "1234",
      chat_id: "oc_raw",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      ...overrides.message
    }
  };
}
