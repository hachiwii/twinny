import { describe, expect, it, vi } from "vitest";
import { LarkUserOAuthDeviceFlow, TenantAccessTokenManager } from "./auth.js";
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

describe("LarkUserOAuthDeviceFlow", () => {
  it("starts device authorization with offline access and basic auth", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        device_code: "device-code",
        user_code: "USER-CODE",
        verification_uri: "https://accounts.feishu.cn/page/cli",
        verification_uri_complete: "https://accounts.feishu.cn/page/cli?user_code=USER-CODE",
        expires_in: 240,
        interval: 5
      })
    ) satisfies FetchLike;
    const flow = new LarkUserOAuthDeviceFlow({
      appId: "cli_123",
      appSecret: "secret",
      fetch
    });

    await expect(flow.requestDeviceAuthorization("calendar:calendar:readonly")).resolves.toMatchObject({
      deviceCode: "device-code",
      userCode: "USER-CODE",
      verificationUriComplete: "https://accounts.feishu.cn/page/cli?user_code=USER-CODE"
    });

    expect(fetch).toHaveBeenCalledWith("https://accounts.feishu.cn/oauth/v1/device_authorization", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("cli_123:secret").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: "client_id=cli_123&scope=calendar%3Acalendar%3Areadonly+offline_access"
    });
  });

  it("polls the device token endpoint until authorization completes", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }))
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "user-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          refresh_token_expires_in: 86400,
          scope: "offline_access"
        })
      ) satisfies FetchLike;
    const sleep = vi.fn(async () => undefined);
    const flow = new LarkUserOAuthDeviceFlow({
      appId: "cli_123",
      appSecret: "secret",
      fetch,
      sleep
    });

    await expect(flow.pollDeviceToken({ deviceCode: "device-code", interval: 1, expiresIn: 240 })).resolves.toEqual({
      accessToken: "user-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
      refreshTokenExpiresIn: 86400,
      scope: "offline_access"
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=device-code&client_id=cli_123&client_secret=secret",
      signal: undefined
    });
  });

  it("gets the logged-in user's open_id with the user token", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: {
          open_id: "ou_owner",
          user_id: "user_owner",
          union_id: "on_union",
          name: "Owner"
        }
      })
    ) satisfies FetchLike;
    const flow = new LarkUserOAuthDeviceFlow({
      appId: "cli_123",
      appSecret: "secret",
      fetch
    });

    await expect(flow.getUserInfo("user-token")).resolves.toEqual({
      openId: "ou_owner",
      userId: "user_owner",
      unionId: "on_union",
      displayName: "Owner"
    });
    expect(fetch).toHaveBeenCalledWith("https://open.feishu.cn/open-apis/authen/v1/user_info", {
      method: "GET",
      headers: {
        authorization: "Bearer user-token"
      }
    });
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
