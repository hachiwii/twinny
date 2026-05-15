import { describe, expect, it, vi } from "vitest";
import { TenantAccessTokenManager } from "./auth.js";
import { LarkMessageSender } from "./messages.js";
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
  const tokenManager = new TenantAccessTokenManager({
    appId: "cli_1234567890abcdef",
    appSecret: "secret",
    fetch
  });
  const openApiClient = new LarkOpenApiClient({
    tokenManager,
    fetch,
    retryBaseDelayMs: 0
  });
  return new LarkMessageSender({ openApiClient, logger });
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
