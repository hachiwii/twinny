import { describe, expect, it, vi } from "vitest";
import { TenantAccessTokenManager } from "./auth.js";
import { LarkUserDirectory } from "./contact.js";
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

function createDirectory(fetch: FetchLike) {
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
  return new LarkUserDirectory({ openApiClient });
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
