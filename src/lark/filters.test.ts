import { describe, expect, it } from "vitest";
import {
  normalizeIncomingLarkMessage,
  normalizeIncomingLarkMessageWithReason,
  normalizeLarkBotMenuWithReason,
  normalizeLarkDocCommentAddWithReason,
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

  it("converts JSON 2.0 interactive cards into flattened card text with downloadable resources", () => {
    const normalized = normalizeIncomingLarkMessage(
      receiveEvent({
        message: {
          message_type: "interactive",
          content: JSON.stringify({
            schema: "2.0",
            header: {
              title: { tag: "plain_text", content: 'Status & "Plan" <v2>' },
              subtitle: { tag: "plain_text", content: "Sub > Ready" }
            },
            body: {
              elements: [
                { tag: "markdown", content: "**Keep <raw>& body**" },
                { tag: "div", text: { tag: "plain_text", content: "Div <raw> & body" } },
                { tag: "plain_text", content: "Plain text body" },
                {
                  tag: "column_set",
                  columns: [
                    {
                      tag: "column",
                      elements: [{ tag: "markdown", content: "Nested column text" }]
                    }
                  ]
                },
                {
                  tag: "collapsible_panel",
                  header: { title: { tag: "plain_text", content: "Panel title" } },
                  elements: [{ tag: "div", text: { tag: "plain_text", content: "Panel body" } }]
                },
                { tag: "button", text: { tag: "plain_text", content: "Ignored button" } },
                { tag: "select_static", placeholder: { tag: "plain_text", content: "Ignored select" } },
                { tag: "input", placeholder: { tag: "plain_text", content: "Ignored input" } },
                { tag: "chart", chart_spec: { title: "Ignored chart" } },
                { tag: "img", img_key: "img_card" },
                { tag: "media", file_key: "file_card" }
              ]
            }
          })
        }
      })
    );

    expect(normalized).toMatchObject({
      messageId: "om_1",
      messageType: "interactive",
      text:
        '<card title="Status &amp; &quot;Plan&quot; &lt;v2&gt;" subtitle="Sub &gt; Ready">\n' +
        "**Keep <raw>& body**\n" +
        "Div <raw> & body\n" +
        "Plain text body\n" +
        "Nested column text\n" +
        "Panel title\n" +
        "Panel body\n" +
        "{{TWINNY_LARK_RESOURCE_0}}\n" +
        "{{TWINNY_LARK_RESOURCE_1}}\n" +
        "</card>",
      resources: [
        { resourceType: "image", fileKey: "img_card", codexTag: "file", textPlaceholder: "{{TWINNY_LARK_RESOURCE_0}}" },
        { resourceType: "file", fileKey: "file_card", codexTag: "file", textPlaceholder: "{{TWINNY_LARK_RESOURCE_1}}" }
      ]
    });
    expect(normalized?.rawForCodex).toBeUndefined();
    expect(normalized?.text).not.toContain("Ignored");
  });

  it("converts nested user_dsl interactive cards into flattened card text", () => {
    const normalized = normalizeIncomingLarkMessage(
      receiveEvent({
        message: {
          message_type: "interactive",
          content: JSON.stringify({
            title: "fallback title",
            elements: [[{ tag: "text", text: "fallback body" }]],
            user_dsl: JSON.stringify({
              schema: "2.0",
              header: {
                title: { tag: "plain_text", content: "User Card" }
              },
              body: {
                elements: [
                  { tag: "markdown", content: "Nested **body**" },
                  { tag: "img", image_key: "img_nested" }
                ]
              }
            })
          })
        }
      })
    );

    expect(normalized).toMatchObject({
      messageId: "om_1",
      messageType: "interactive",
      text:
        '<card title="User Card">\n' +
        "Nested **body**\n" +
        "{{TWINNY_LARK_RESOURCE_0}}\n" +
        "</card>",
      resources: [
        { resourceType: "image", fileKey: "img_nested", codexTag: "file", textPlaceholder: "{{TWINNY_LARK_RESOURCE_0}}" }
      ]
    });
    expect(normalized?.rawForCodex).toBeUndefined();
    expect(normalized?.text).not.toContain("fallback");
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
      text: JSON.stringify({
        message_type: "merge_forward",
        content: JSON.stringify({ message_id_list: ["om_child"] })
      })
    });
  });

  it("forwards non-2.0 interactive cards as raw message JSON", () => {
    const event = receiveEvent({
      message: {
        message_type: "interactive",
        content: JSON.stringify({
          header: { title: { tag: "plain_text", content: "old card" } },
          elements: [{ tag: "markdown", content: "legacy body" }]
        })
      }
    });

    const normalized = normalizeIncomingLarkMessage(event);

    expect(normalized).toMatchObject({
      messageId: "om_1",
      messageType: "interactive",
      rawForCodex: true,
      text: JSON.stringify({
        message_type: "interactive",
        content: JSON.stringify({
          header: { title: { tag: "plain_text", content: "old card" } },
          elements: [{ tag: "markdown", content: "legacy body" }]
        })
      })
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
      text: JSON.stringify({
        message_type: "post",
        content: JSON.stringify({ title: "No content array" })
      })
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
      text: JSON.stringify({
        message_type: "unknown",
        content: JSON.stringify({ custom: true })
      })
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

describe("normalizeLarkDocCommentAddWithReason", () => {
  it("normalizes mentioned doc comment add events", () => {
    expect(
      normalizeLarkDocCommentAddWithReason({
        header: { event_id: "event-doc-comment", create_time: "1234567890" },
        event: {
          file: { file_type: "docx", token: "doc_token" },
          comment: {
            id: "comment_1",
            user_name: "Fallback User"
          },
          reply: {
            reply_id: "reply_1",
            user_id: "ou_reply_user",
            is_mentioned: "true",
            create_time: "1234567891"
          },
          operator: {
            name: "Owner",
            operator_id: { open_id: "ou_owner" }
          }
        }
      })
    ).toEqual({
      kind: "doc_comment",
      comment: {
        eventId: "event-doc-comment",
        fileType: "docx",
        fileToken: "doc_token",
        commentId: "comment_1",
        replyId: "reply_1",
        senderOpenId: "ou_owner",
        senderName: "Owner",
        isMentioned: true,
        createTime: 1234567891,
        raw: expect.anything()
      }
    });
  });

  it("normalizes drive notice doc comment events with notice_meta", () => {
    expect(
      normalizeLarkDocCommentAddWithReason({
        schema: "2.0",
        event_id: "event-doc-comment-notice",
        create_time: "1779806422000",
        event_type: "drive.notice.comment_add_v1",
        comment_id: "7644210372219555015",
        is_mentioned: true,
        notice_meta: {
          file_token: "O8TAd0SLAo95U8xclgFcE4Ppnd1",
          file_type: "docx",
          from_user_id: {
            open_id: "ou_owner",
            union_id: "on_owner",
            user_id: null
          },
          notice_type: "add_comment",
          to_user_id: {
            open_id: "ou_bot",
            union_id: "on_bot",
            user_id: null
          }
        },
        reply_id: "7644210372240510137"
      })
    ).toEqual({
      kind: "doc_comment",
      comment: {
        eventId: "event-doc-comment-notice",
        fileType: "docx",
        fileToken: "O8TAd0SLAo95U8xclgFcE4Ppnd1",
        commentId: "7644210372219555015",
        replyId: "7644210372240510137",
        senderOpenId: "ou_owner",
        senderName: undefined,
        isMentioned: true,
        createTime: 1779806422000,
        raw: expect.anything()
      }
    });
  });

  it("ignores malformed doc comment add events", () => {
    expect(normalizeLarkDocCommentAddWithReason({ event: { comment_id: "comment_1" } })).toMatchObject({
      kind: "ignored",
      reason: "missing_file"
    });
    expect(
      normalizeLarkDocCommentAddWithReason({
        event: {
          file_type: "docx",
          file_token: "doc_token",
          operator: { operator_id: { open_id: "ou_owner" } }
        }
      })
    ).toMatchObject({ kind: "ignored", reason: "missing_comment_id" });
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
