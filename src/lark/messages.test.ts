import { describe, expect, it, vi } from "vitest";
import { TenantAccessTokenManager } from "./auth.js";
import { LarkMessageReader, LarkMessageSender, LarkMessageUnavailableError } from "./messages.js";
import { LarkOpenApiClient } from "./openapi.js";
import type { FetchLike, LarkLogger } from "./types.js";
import type { LarkMessageRedactionConfig } from "../types.js";

describe("LarkMessageSender", () => {
  it("replies with a text message through OpenAPI", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_reply" } }
    ]);
    const sender = createSender(fetch);

    await expect(sender.replyText("om_source", "hello back", { uuid: "uuid-1" })).resolves.toMatchObject({
      messageId: "om_reply"
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: JSON.stringify({ text: "hello back" }),
        msg_type: "text",
        uuid: "uuid-1"
      }),
      signal: undefined
    });
  });

  it("marks replies as in-thread when requested", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_reply", thread_id: "omt_thread" } }
    ]);
    const sender = createSender(fetch);

    await expect(sender.replyText("om_source", "hello thread", { replyInThread: true })).resolves.toMatchObject({
      messageId: "om_reply",
      raw: { data: { thread_id: "omt_thread" } }
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: JSON.stringify({ text: "hello thread" }),
        msg_type: "text",
        reply_in_thread: true
      }),
      signal: undefined
    });
  });

  it("replies with a markdown post through OpenAPI", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_reply" } }
    ]);
    const sender = createSender(fetch);

    await expect(sender.replyMarkdown("om_source", "## hello\n\n- item", { uuid: "uuid-1" })).resolves.toMatchObject({
      messageId: "om_reply"
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: JSON.stringify({
          zh_cn: {
            content: [[{ tag: "md", text: "## hello\n\n- item" }]]
          }
        }),
        msg_type: "post",
        uuid: "uuid-1"
      }),
      signal: undefined
    });
  });

  it("replies with a rich post containing uploaded media nodes", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_reply" } }
    ]);
    const sender = createSender(fetch);

    await expect(
      sender.replyPost("om_source", [
        [{ tag: "md", text: "hello" }],
        [{ tag: "img", image_key: "img_1" }],
        [{ tag: "media", file_key: "file_1" }]
      ])
    ).resolves.toMatchObject({ messageId: "om_reply" });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: JSON.stringify({
          zh_cn: {
            content: [
              [{ tag: "md", text: "hello" }],
              [{ tag: "img", image_key: "img_1" }],
              [{ tag: "media", file_key: "file_1" }]
            ]
          }
        }),
        msg_type: "post"
      }),
      signal: undefined
    });
  });

  it("replies with an interactive card through OpenAPI", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_card" } }
    ]);
    const sender = createSender(fetch);
    const card = { schema: "2.0", body: { elements: [{ tag: "markdown", content: "working" }] } };

    await expect(sender.replyInteractiveCard("om_source", card, { uuid: "uuid-1" })).resolves.toMatchObject({
      messageId: "om_card"
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: JSON.stringify(card),
        msg_type: "interactive",
        uuid: "uuid-1"
      }),
      signal: undefined
    });
  });

  it("marks interactive card replies as in-thread when requested", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_card", thread_id: "omt_thread" } }
    ]);
    const sender = createSender(fetch);
    const card = { schema: "2.0", body: { elements: [{ tag: "markdown", content: "working" }] } };

    await expect(sender.replyInteractiveCard("om_source", card, { replyInThread: true })).resolves.toMatchObject({
      messageId: "om_card",
      raw: { data: { thread_id: "omt_thread" } }
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: JSON.stringify(card),
        msg_type: "interactive",
        reply_in_thread: true
      }),
      signal: undefined
    });
  });

  it("patches an interactive card message through OpenAPI", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_card" } }
    ]);
    const sender = createSender(fetch);
    const card = { schema: "2.0", header: { template: "green" } };

    await expect(sender.patchInteractiveCard("om_card", card, { uuid: "uuid-1" })).resolves.toMatchObject({
      messageId: "om_card"
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages/om_card", {
      method: "PATCH",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: JSON.stringify(card),
        uuid: "uuid-1"
      }),
      signal: undefined
    });
  });

  it("deletes messages through OpenAPI for card recall", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: {} }
    ]);
    const sender = createSender(fetch);

    await expect(sender.deleteMessage("om_card")).resolves.toBeUndefined();

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages/om_card", {
      method: "DELETE",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: undefined,
      signal: undefined
    });
  });

  it("deletes ephemeral message cards through OpenAPI", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: {} }
    ]);
    const sender = createSender(fetch);

    await expect(sender.deleteEphemeralMessage("om_ephemeral")).resolves.toBeUndefined();

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/ephemeral/v1/delete", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message_id: "om_ephemeral"
      }),
      signal: undefined
    });
  });

  it("lists message read users as open_ids through OpenAPI", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      {
        code: 0,
        data: {
          has_more: true,
          page_token: "next-page",
          items: [{ user_id: "ou_1" }]
        }
      },
      {
        code: 0,
        data: {
          has_more: false,
          items: [{ user_id: "ou_2" }]
        }
      }
    ]);
    const sender = createSender(fetch);

    await expect(sender.listMessageReadOpenIds("om_card")).resolves.toEqual(["ou_1", "ou_2"]);

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/im/v1/messages/om_card/read_users?user_id_type=open_id&page_size=100",
      {
        method: "GET",
        headers: {
          authorization: "Bearer tenant-token",
          "content-type": "application/json"
        },
        body: undefined,
        signal: undefined
      }
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "https://open.feishu.cn/open-apis/im/v1/messages/om_card/read_users?user_id_type=open_id&page_size=100&page_token=next-page",
      {
        method: "GET",
        headers: {
          authorization: "Bearer tenant-token",
          "content-type": "application/json"
        },
        body: undefined,
        signal: undefined
      }
    );
  });

  it("replies with a file message through OpenAPI", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_reply" } }
    ]);
    const sender = createSender(fetch);

    await expect(sender.replyFile("om_source", "file_1")).resolves.toMatchObject({ messageId: "om_reply" });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: JSON.stringify({ file_key: "file_1" }),
        msg_type: "file"
      }),
      signal: undefined
    });
  });

  it("replies with an image message through OpenAPI", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_reply" } }
    ]);
    const sender = createSender(fetch);

    await expect(sender.replyImage("om_source", "img_1")).resolves.toMatchObject({ messageId: "om_reply" });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content: JSON.stringify({ image_key: "img_1" }),
        msg_type: "image"
      }),
      signal: undefined
    });
  });

  it("optionally sends p2p text to open_id", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_sent" } }
    ]);
    const sender = createSender(fetch);

    await expect(sender.sendTextToOpenId("ou_user", "hello")).resolves.toMatchObject({
      messageId: "om_sent"
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        receive_id: "ou_user",
        content: JSON.stringify({ text: "hello" }),
        msg_type: "text"
      }),
      signal: undefined
    });
  });

  it("sends an interactive card directly to an open_id", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_card" } }
    ]);
    const sender = createSender(fetch);
    const card = { schema: "2.0", header: { title: { tag: "plain_text", content: "Twinny" } } };

    await expect(sender.sendInteractiveCardToOpenId("ou_user", card, { uuid: "uuid-card" })).resolves.toMatchObject({
      messageId: "om_card"
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        receive_id: "ou_user",
        content: JSON.stringify(card),
        msg_type: "interactive",
        uuid: "uuid-card"
      }),
      signal: undefined
    });
  });

  it("sends an interactive card directly to a chat_id", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_card" } }
    ]);
    const sender = createSender(fetch);
    const card = { schema: "2.0", header: { title: { tag: "plain_text", content: "新会话" } } };

    await expect(sender.sendInteractiveCardToChatId("oc_group", card, { uuid: "uuid-card" })).resolves.toMatchObject({
      messageId: "om_card"
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        receive_id: "oc_group",
        content: JSON.stringify(card),
        msg_type: "interactive",
        uuid: "uuid-card"
      }),
      signal: undefined
    });
  });

  it("sends an ephemeral interactive card to a group member", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_ephemeral" } }
    ]);
    const sender = createSender(fetch);
    const card = { schema: "2.0", body: { elements: [{ tag: "markdown", content: "status" }] } };

    await expect(sender.sendEphemeralInteractiveCardToChatId("oc_group", "ou_user", card)).resolves.toMatchObject({
      messageId: "om_ephemeral"
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/ephemeral/v1/send", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: "oc_group",
        open_id: "ou_user",
        msg_type: "interactive",
        card
      }),
      signal: undefined
    });
  });

  it("redacts sensitive text content before sending text and cards", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_text" } },
      { code: 0, data: { message_id: "om_card" } }
    ]);
    const sender = createSender(fetch);
    const card = {
      schema: "2.0",
      body: {
        elements: [
          {
            tag: "markdown",
            content: "contact bob@example.com 13912345678",
            behaviors: [{ type: "callback", value: { raw: "bob@example.com 13912345678" } }]
          }
        ]
      }
    };

    await sender.replyText("om_source", "call alice@example.com 13812345678");
    await sender.sendInteractiveCardToChatId("oc_group", card);

    const textBody = JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string) as { content: string };
    expect(JSON.parse(textBody.content)).toEqual({ text: "call a***e@example.com 138****5678" });

    const cardBody = JSON.parse(vi.mocked(fetch).mock.calls[2]![1]!.body as string) as { content: string };
    expect(JSON.parse(cardBody.content)).toMatchObject({
      body: {
        elements: [
          {
            content: "contact b*b@example.com 139****5678",
            behaviors: [{ value: { raw: "b*b@example.com 139****5678" } }]
          }
        ]
      }
    });
  });

  it("supports whitespace and none redaction strategies", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_text" } }
    ]);
    const sender = createSender(fetch, undefined, {
      email: "whitespace",
      chinesePhoneNumber: "none"
    });

    await sender.replyText("om_source", "call alice@example.com 13812345678");

    const body = JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string) as { content: string };
    expect(JSON.parse(body.content)).toEqual({ text: "call alice @ example.com 13812345678" });
  });

  it("forwards a thread to another thread through OpenAPI", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_forward" } }
    ]);
    const sender = createSender(fetch);

    await expect(sender.forwardThreadToThread("omt_agent", "omt_original", { uuid: "uuid-forward" })).resolves.toMatchObject({
      messageId: "om_forward"
    });

    expect(fetch).toHaveBeenLastCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/threads/omt_agent/forward?receive_id_type=thread_id&uuid=uuid-forward",
      {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          receive_id: "omt_original"
        }),
        signal: undefined
      }
    );
  });

  it("fetches a message through the mget API", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      {
        code: 0,
        data: {
          items: [
            {
              message_id: "om_source",
              msg_type: "text",
              body: { content: JSON.stringify({ text: "latest" }) }
            }
          ]
        }
      }
    ]);
    const reader = createReader(fetch);

    await expect(reader.getMessage("om_source")).resolves.toMatchObject({
      message_id: "om_source",
      msg_type: "text"
    });

    expect(fetch).toHaveBeenLastCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/mget?card_msg_content_type=user_card_content&message_ids=om_source",
      {
        method: "GET",
        headers: {
          authorization: "Bearer tenant-token",
          "content-type": "application/json"
        },
        body: undefined,
        signal: undefined
      }
    );
  });

  it("fetches merge-forward message items through the get API with user card content", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      {
        code: 0,
        data: {
          items: [
            { message_id: "om_outer", msg_type: "merge_forward", body: { content: "Merged and Forwarded Message" } },
            { message_id: "om_child", upper_message_id: "om_outer", msg_type: "text", body: { content: JSON.stringify({ text: "child" }) } }
          ]
        }
      }
    ]);
    const reader = createReader(fetch);

    await expect(reader.getMessageItems("om_outer")).resolves.toHaveLength(2);

    expect(fetch).toHaveBeenLastCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_outer?user_id_type=open_id&card_msg_content_type=user_card_content",
      {
        method: "GET",
        headers: {
          authorization: "Bearer tenant-token",
          "content-type": "application/json"
        },
        body: undefined,
        signal: undefined
      }
    );
  });

  it("reports omitted or deleted mget messages as unavailable", async () => {
    const omittedFetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { items: [] } }
    ]);
    await expect(createReader(omittedFetch).getMessage("om_missing")).rejects.toBeInstanceOf(LarkMessageUnavailableError);

    const deletedFetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { items: [{ message_id: "om_deleted", deleted: true }] } }
    ]);
    await expect(createReader(deletedFetch).getMessage("om_deleted")).rejects.toMatchObject({
      code: "LARK_MESSAGE_UNAVAILABLE",
      messageId: "om_deleted"
    });
  });

  it("creates and deletes default working reactions", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { reaction_id: "reaction-1" } },
      { code: 0, data: { reaction_id: "reaction-1" } }
    ]);
    const sender = createSender(fetch);

    const handle = await sender.createTypingReaction("om_source");
    expect(handle).toEqual({ messageId: "om_source", reactionId: "reaction-1" });
    await sender.deleteTypingReaction(handle);

    expect(fetch).toHaveBeenNthCalledWith(2, "https://open.feishu.cn/open-apis/im/v1/messages/om_source/reactions", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        reaction_type: {
          emoji_type: "JubilantRabbit"
        }
      }),
      signal: undefined
    });
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "https://open.feishu.cn/open-apis/im/v1/messages/om_source/reactions/reaction-1",
      {
        method: "DELETE",
        headers: {
          authorization: "Bearer tenant-token",
          "content-type": "application/json"
        },
        body: undefined,
        signal: undefined
      }
    );
  });

  it("creates configured working reactions", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { reaction_id: "reaction-1" } }
    ]);
    const sender = createSender(fetch);

    const handle = await sender.createReaction("om_source", "JubilantRabbit");

    expect(handle).toEqual({ messageId: "om_source", reactionId: "reaction-1" });
    expect(fetch).toHaveBeenNthCalledWith(2, "https://open.feishu.cn/open-apis/im/v1/messages/om_source/reactions", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        reaction_type: {
          emoji_type: "JubilantRabbit"
        }
      }),
      signal: undefined
    });
  });

  it("treats working reaction failures as non-fatal", async () => {
    const logger = { warn: vi.fn() } satisfies LarkLogger;
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 999, msg: "reaction denied" }
    ]);
    const sender = createSender(fetch, logger);

    await expect(sender.createTypingReaction("om_source")).resolves.toBeNull();
    await expect(sender.deleteTypingReaction({ messageId: "om_source", reactionId: "reaction-1" })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

function createSender(fetch: FetchLike, logger?: LarkLogger, redaction?: Partial<LarkMessageRedactionConfig>) {
  const openApiClient = createOpenApiClient(fetch);
  return new LarkMessageSender({ openApiClient, logger, redaction });
}

function createReader(fetch: FetchLike) {
  return new LarkMessageReader({ openApiClient: createOpenApiClient(fetch) });
}

function createOpenApiClient(fetch: FetchLike) {
  const tokenManager = new TenantAccessTokenManager({
    appId: "cli_1234567890abcdef",
    appSecret: "secret",
    fetch
  });
  return new LarkOpenApiClient({
    tokenManager,
    fetch,
    retryBaseDelayMs: 0
  });
}

function sequenceFetch(bodies: unknown[]): FetchLike {
  const fetch = vi.fn(async () => {
    const body = bodies.shift();
    if (body === undefined) {
      throw new Error("unexpected fetch call");
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body
    };
  });
  return fetch;
}
