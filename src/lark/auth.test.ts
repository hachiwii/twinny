import { describe, expect, it, vi } from "vitest";
import { TenantAccessTokenManager } from "./auth.js";
import type { FetchLike } from "./types.js";

describe("TenantAccessTokenManager", () => {
  it("fetches and caches tenant access tokens", async () => {
    let now = 1_000;
    const fetch = vi.fn(async () => jsonResponse({ code: 0, tenant_access_token: "token-1", expire: 7200 })) satisfies FetchLike;
    const manager = new TenantAccessTokenManager({
      appId: "cli_1234567890abcdef",
      appSecret: "secret",
      fetch,
      now: () => now
    });

    await expect(manager.getTenantAccessToken()).resolves.toBe("token-1");
    await expect(manager.getTenantAccessToken()).resolves.toBe("token-1");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        app_id: "cli_1234567890abcdef",
        app_secret: "secret"
      })
    });

    now += 7_200_000;
    await expect(manager.getTenantAccessToken()).resolves.toBe("token-1");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares concurrent refreshes", async () => {
    let resolveFetch!: (value: ReturnType<typeof jsonResponse>) => void;
    const fetch = vi.fn(
      () =>
        new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
          resolveFetch = resolve;
        })
    ) satisfies FetchLike;
    const manager = new TenantAccessTokenManager({
      appId: "cli_1234567890abcdef",
      appSecret: "secret",
      fetch
    });

    const first = manager.getTenantAccessToken();
    const second = manager.getTenantAccessToken();
    resolveFetch(jsonResponse({ code: 0, tenant_access_token: "token-1", expire: 7200 }));

    await expect(Promise.all([first, second])).resolves.toEqual(["token-1", "token-1"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body
  };
}
