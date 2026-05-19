import { describe, expect, it, vi } from "vitest";
import { TenantAccessTokenManager } from "./auth.js";
import { LarkBotDirectory, LarkChatDirectory, LarkUserDirectory } from "./contact.js";
import { LarkOpenApiClient } from "./openapi.js";
import type { FetchLike } from "./types.js";

describe("LarkUserDirectory", () => {
  it("fetches a user's display name by open_id", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { user: { name: "张三", en_name: "San Zhang" } } }
    ]);
    const directory = createDirectory(fetch);

    await expect(directory.getUserNameByOpenId("ou_user")).resolves.toBe("张三");

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/contact/v3/users/ou_user?user_id_type=open_id", {
      method: "GET",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: undefined,
      signal: undefined
    });
  });
});

describe("LarkChatDirectory", () => {
  it("fetches a group's name and chat mode by chat id", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { name: "工程群", chat_mode: "topic" } }
    ]);
    const directory = new LarkChatDirectory({ openApiClient: createOpenApiClient(fetch) });

    await expect(directory.getChatInfo("oc_group")).resolves.toEqual({ name: "工程群", chatMode: "topic" });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/chats/oc_group?user_id_type=open_id", {
      method: "GET",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: undefined,
      signal: undefined
    });
  });

  it("preserves p2p chat mode from chat info responses", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { name: "单聊", chat_mode: "p2p" } }
    ]);
    const directory = new LarkChatDirectory({ openApiClient: createOpenApiClient(fetch) });

    await expect(directory.getChatInfo("oc_p2p")).resolves.toEqual({ name: "单聊", chatMode: "p2p" });
  });

  it("keeps getChatName as a compatibility wrapper", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { chat: { name: "工程群" } } }
    ]);
    const directory = new LarkChatDirectory({ openApiClient: createOpenApiClient(fetch) });

    await expect(directory.getChatName("oc_group")).resolves.toBe("工程群");

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/chats/oc_group?user_id_type=open_id", {
      method: "GET",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: undefined,
      signal: undefined
    });
  });

  it("creates a chat-mode group", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { chat_id: "oc_project" } }
    ]);
    const directory = new LarkChatDirectory({ openApiClient: createOpenApiClient(fetch) });

    await expect(directory.createChat({
      name: "twinny",
      ownerOpenId: "ou_owner",
      userOpenIds: ["ou_owner"],
      groupMessageType: "chat",
      uuid: "uuid-project",
      setBotManager: true
    })).resolves.toMatchObject({ chatId: "oc_project" });

    expect(fetch).toHaveBeenLastCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/chats?user_id_type=open_id&uuid=uuid-project&set_bot_manager=true",
      {
        method: "POST",
        headers: {
          authorization: "Bearer tenant-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "twinny",
          chat_type: "private",
          group_message_type: "chat",
          owner_id: "ou_owner",
          user_id_list: ["ou_owner"]
        }),
        signal: undefined
      }
    );
  });
});

describe("LarkBotDirectory", () => {
  it("fetches the bot open_id", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { bot: { open_id: "ou_bot" } } }
    ]);
    const directory = new LarkBotDirectory({ openApiClient: createOpenApiClient(fetch) });

    await expect(directory.getBotOpenId()).resolves.toBe("ou_bot");

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/bot/v3/info", {
      method: "GET",
      headers: {
        authorization: "Bearer tenant-token",
        "content-type": "application/json"
      },
      body: undefined,
      signal: undefined
    });
  });
});

function createDirectory(fetch: FetchLike) {
  return new LarkUserDirectory({ openApiClient: createOpenApiClient(fetch) });
}

function createOpenApiClient(fetch: FetchLike) {
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
  return openApiClient;
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
