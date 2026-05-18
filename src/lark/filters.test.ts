import { describe, expect, it } from "vitest";
import {
  normalizeIncomingLarkMessage,
  normalizeIncomingLarkMessageWithReason,
  normalizeLarkBotMenuWithReason,
  normalizeLarkMessageRecallWithReason,
  normalizeTextContent
} from "./filters.js";

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

  it.each(["file", "audio", "media", "video"])(
    "normalizes p2p %s events as downloadable file resources",
    (messageType) => {
      const normalized = normalizeIncomingLarkMessage(
        receiveEvent({
          message: {
            message_type: messageType,
            content: JSON.stringify({ file_key: "file_123", file_name: "clip.mp4" })
          }
        })
      );

      expect(normalized).toMatchObject({
        messageId: "om_1",
        messageType,
        text: "收到一个文件，资源 key：file_123",
        resources: [{ resourceType: "file", fileKey: "file_123", fileName: "clip.mp4" }]
      });
    }
  );

  it("converts p2p post events into markdown with downloadable media placeholders", () => {
    const normalized = normalizeIncomingLarkMessage(
      receiveEvent({
        message: {
          message_type: "post",
          content: JSON.stringify({
            title: "Status",
            content: [
              [
                { tag: "text", text: "Please inspect " },
                { tag: "a", text: "the docs", href: "https://open.feishu.cn" },
                { tag: "at", user_name: "Tom", user_id: "@_user_1" }
              ],
              [{ tag: "img", image_key: "img_123" }],
              [{ tag: "media", file_key: "file_123", image_key: "img_cover" }],
              [{ tag: "code_block", language: "JSON", text: '{"ok":true}' }]
            ]
          })
        }
      })
    );

    expect(normalized).toMatchObject({
      messageId: "om_1",
      messageType: "post",
      text:
        "# Status\n\n" +
        "Please inspect [the docs](https://open.feishu.cn)@Tom\n\n" +
        "{{TWINNY_LARK_RESOURCE_0}}\n\n" +
        "{{TWINNY_LARK_RESOURCE_1}}\n\n" +
        '```json\n{"ok":true}\n```',
      resources: [
        { resourceType: "image", fileKey: "img_123", codexTag: "img", textPlaceholder: "{{TWINNY_LARK_RESOURCE_0}}" },
        { resourceType: "file", fileKey: "file_123", codexTag: "video", textPlaceholder: "{{TWINNY_LARK_RESOURCE_1}}" }
      ]
    });
  });

  it("normalizes unsupported p2p message types as raw messages for Codex", () => {
    const event = receiveEvent({
      message: {
        message_type: "merge_forward",
        content: JSON.stringify({ message_id_list: ["om_child"] })
      }
    });

    const normalized = normalizeIncomingLarkMessage(event);

    expect(normalized).toMatchObject({
      messageId: "om_1",
      messageType: "merge_forward",
      rawForCodex: true,
      text: JSON.stringify(event.message)
    });
  });

  it("forwards malformed known message content as raw message JSON", () => {
    const event = receiveEvent({
      message: {
        message_type: "post",
        content: JSON.stringify({ title: "No content array" })
      }
    });

    const normalized = normalizeIncomingLarkMessage(event);

    expect(normalized).toMatchObject({
      messageId: "om_1",
      messageType: "post",
      rawForCodex: true,
      text: JSON.stringify(event.message)
    });
  });

  it("forwards messages without a message_type as raw message JSON", () => {
    const event = receiveEvent({
      message: {
        message_type: undefined,
        content: JSON.stringify({ custom: true })
      }
    });

    const normalized = normalizeIncomingLarkMessage(event);

    expect(normalized).toMatchObject({
      messageId: "om_1",
      messageType: "unknown",
      rawForCodex: true,
      text: JSON.stringify(event.message)
    });
  });

  it("normalizes group messages with chat id and mentions", () => {
    const result = normalizeIncomingLarkMessage(
      receiveEvent({
        message: {
          chat_id: "oc_group",
          chat_type: "group",
          mentions: [
            {
              key: "@_user_1",
              id: { open_id: "ou_bot", user_id: "u_bot" },
              name: "Twinny"
            }
          ]
        }
      })
    );

    expect(result).toMatchObject({
      chatId: "oc_group",
      chatType: "group",
      larkGroupId: "oc_group",
      mentions: [{ key: "@_user_1", openId: "ou_bot", userId: "u_bot", name: "Twinny" }]
    });
  });

  it("normalizes topic-group thread ids by thread, root, parent, then message id", () => {
    expect(
      normalizeIncomingLarkMessage(
        receiveEvent({
          message: {
            chat_id: "oc_group",
            chat_type: "topic_group",
            thread_id: "omt_thread",
            root_id: "om_root",
            parent_id: "om_parent"
          }
        })
      )
    ).toMatchObject({
      chatId: "oc_group",
      chatType: "topic_group",
      larkThreadId: "omt_thread",
      larkRootMessageId: "om_root",
      larkParentMessageId: "om_parent"
    });
    expect(
      normalizeIncomingLarkMessage(
        receiveEvent({
          message: {
            chat_id: "oc_group",
            chat_type: "topic_group",
            root_id: "om_root",
            parent_id: "om_parent"
          }
        })
      )
    ).toMatchObject({ larkThreadId: "om_root" });
    expect(
      normalizeIncomingLarkMessage(
        receiveEvent({
          message: {
            chat_id: "oc_group",
            chat_type: "topic_group",
            parent_id: "om_parent"
          }
        })
      )
    ).toMatchObject({ larkThreadId: "om_parent" });
    expect(
      normalizeIncomingLarkMessage(
        receiveEvent({
          message: {
            chat_id: "oc_group",
            chat_type: "topic_group"
          }
        })
      )
    ).toMatchObject({ larkThreadId: "om_1" });
  });

  it("keeps group events as group while exposing a topic thread_id", () => {
    expect(
      normalizeIncomingLarkMessage(
        receiveEvent({
          message: {
            chat_id: "oc_group",
            chat_type: "group",
            thread_id: "omt_topic"
          }
        })
      )
    ).toMatchObject({
      chatId: "oc_group",
      chatType: "group",
      larkThreadId: "omt_topic"
    });
  });

  it("exposes thread ids even when they arrive on p2p messages", () => {
    expect(
      normalizeIncomingLarkMessage(
        receiveEvent({
          message: {
            chat_type: "p2p",
            thread_id: "omt_dm"
          }
        })
      )
    ).toMatchObject({
      chatId: "ou_user",
      chatType: "p2p",
      larkThreadId: "omt_dm"
    });
  });

  it("ignores unsupported chat and bot-self messages", () => {
    expect(normalizeIncomingLarkMessageWithReason(receiveEvent({ message: { chat_type: "meeting" } }))).toMatchObject({
      kind: "ignored",
      reason: "unsupported_chat_type"
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

describe("normalizeLarkMessageRecallWithReason", () => {
  it("normalizes v2 recalled message events", () => {
    expect(
      normalizeLarkMessageRecallWithReason({
        header: { event_id: "event-recall" },
        event: {
          message_id: "om_1",
          chat_id: "oc_1",
          recall_time: "1615380573411"
        }
      })
    ).toEqual({
      kind: "recall",
      recall: {
        eventId: "event-recall",
        messageId: "om_1",
        chatId: "oc_1",
        recallTime: 1615380573411,
        raw: expect.anything()
      }
    });
  });
});

describe("normalizeLarkBotMenuWithReason", () => {
  it("normalizes bot floating menu events by operator open_id and event_key", () => {
    expect(
      normalizeLarkBotMenuWithReason({
        header: { event_id: "event-menu" },
        event: {
          operator: {
            operator_name: "Guest User",
            operator_id: { open_id: "ou_guest", user_id: "u_guest" }
          },
          event_key: "queue",
          timestamp: 1669364458
        }
      })
    ).toEqual({
      kind: "bot_menu",
      action: {
        eventId: "event-menu",
        eventKey: "queue",
        action: "queue",
        operatorOpenId: "ou_guest",
        operatorName: "Guest User",
        timestamp: 1669364458,
        raw: expect.anything()
      }
    });
  });

  it("normalizes group new-session menu events with chat ids", () => {
    expect(
      normalizeLarkBotMenuWithReason({
        header: { event_id: "event-new-session" },
        event: {
          chat_id: "oc_group",
          operator: {
            operator_name: "Owner",
            operator_id: { open_id: "ou_owner" }
          },
          event_key: "new_session",
          timestamp: 1669364459
        }
      })
    ).toEqual({
      kind: "bot_menu",
      action: {
        eventId: "event-new-session",
        eventKey: "new_session",
        action: "new_session",
        operatorOpenId: "ou_owner",
        operatorName: "Owner",
        chatId: "oc_group",
        timestamp: 1669364459,
        raw: expect.anything()
      }
    });
  });

  it("ignores bot menu events with unknown event keys", () => {
    expect(
      normalizeLarkBotMenuWithReason({
        header: { event_id: "event-menu" },
        event: {
          operator: { operator_id: { open_id: "ou_guest" } },
          event_key: "unknown"
        }
      })
    ).toMatchObject({ kind: "ignored", reason: "unsupported_event_key" });
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
