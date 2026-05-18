import { describe, expect, it, vi } from "vitest";
import { TenantAccessTokenManager } from "./auth.js";
import { LarkMessageReader, LarkMessageSender, LarkMessageUnavailableError } from "./messages.js";
import { LarkOpenApiClient } from "./openapi.js";
import type { FetchLike, LarkLogger } from "./types.js";

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

  it("replies by reusing an original raw message payload", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { message_id: "om_reply" } }
    ]);
    const sender = createSender(fetch);
    const content = JSON.stringify({ text: "original text" });

    await expect(sender.replyRawMessage("om_source", { messageType: "text", content }, { uuid: "uuid-raw" })).resolves.toMatchObject({
      messageId: "om_reply"
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content,
        msg_type: "text",
        uuid: "uuid-raw"
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
      "https://open.feishu.cn/open-apis/im/v1/messages/mget?card_msg_content_type=raw_card_content&message_ids=om_source",
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

  it("creates and deletes Typing reactions", async () => {
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
          emoji_type: "Typing"
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

  it("treats Typing reaction failures as non-fatal", async () => {
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

function createSender(fetch: FetchLike, logger?: LarkLogger) {
  const openApiClient = createOpenApiClient(fetch);
  return new LarkMessageSender({ openApiClient, logger });
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
