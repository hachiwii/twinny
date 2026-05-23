import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLarkVerificationUrl,
  getLarkBrowserUserInfo,
  pollLarkAppRegistration,
  pollLarkDeviceToken,
  requestLarkAppRegistration,
  requestLarkDeviceAuthorization
} from "./browser-auth.js";
import type { FetchLike } from "./types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Lark browser auth helpers", () => {
  it("begins app registration through Feishu accounts and displays the selected brand URL", async () => {
    const fetch = vi.fn(async (_input: string, _init?: Parameters<FetchLike>[1]) =>
      jsonResponse({
        device_code: "device-1",
        user_code: "USER1",
        verification_uri: "https://accounts.feishu.cn/page/cli",
        expires_in: 300,
        interval: 5
      })
    ) satisfies FetchLike;

    const result = await requestLarkAppRegistration("lark", { fetch });
    const [, init] = fetch.mock.calls[0];
    const body = new URLSearchParams(init?.body as string);

    expect(fetch.mock.calls[0][0]).toBe("https://accounts.feishu.cn/oauth/v1/app/registration");
    expect(body.get("action")).toBe("begin");
    expect(body.get("archetype")).toBe("PersonalAgent");
    expect(body.get("auth_method")).toBe("client_secret");
    expect(body.get("request_user_info")).toBe("open_id tenant_brand");
    expect(result).toMatchObject({
      deviceCode: "device-1",
      userCode: "USER1",
      verificationUriComplete: "https://open.larksuite.com/page/cli?user_code=USER1"
    });
  });

  it("builds the lark-cli compatible verification URL", () => {
    expect(buildLarkVerificationUrl("https://open.feishu.cn/page/cli?user_code=USER1", "0.1.0")).toBe(
      "https://open.feishu.cn/page/cli?user_code=USER1&lpv=0.1.0&ocv=0.1.0&from=cli"
    );
  });

  it("retries app registration polling against Lark accounts when tenant brand is lark", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          client_id: "cli_lark",
          client_secret: "",
          user_info: { tenant_brand: "lark", open_id: "ou_owner" }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          client_id: "cli_lark",
          client_secret: "secret",
          user_info: { tenant_brand: "lark", open_id: "ou_owner" }
        })
      ) satisfies FetchLike;

    const result = pollLarkAppRegistration("feishu", "device-1", { fetch, interval: 1, expiresIn: 10 });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual({
      appId: "cli_lark",
      appSecret: "secret",
      brand: "lark",
      ownerOpenId: "ou_owner"
    });
    expect(fetch.mock.calls[0][0]).toBe("https://accounts.feishu.cn/oauth/v1/app/registration");
    expect(fetch.mock.calls[1][0]).toBe("https://accounts.larksuite.com/oauth/v1/app/registration");
  });

  it("uses device authorization and token polling endpoints compatible with lark-cli auth login", async () => {
    vi.useFakeTimers();
    const basic = Buffer.from("cli_app:app_secret").toString("base64");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: "device-1",
          user_code: "USER1",
          verification_uri: "https://accounts.feishu.cn/page/cli",
          verification_uri_complete: "https://accounts.feishu.cn/page/cli?user_code=USER1",
          expires_in: 240,
          interval: 1
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "user-token",
          refresh_token: "refresh-token",
          expires_in: 7200,
          refresh_token_expires_in: 604800,
          scope: "offline_access"
        })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { open_id: "ou_owner", name: "Owner" } })) satisfies FetchLike;

    const authorization = await requestLarkDeviceAuthorization(
      { appId: "cli_app", appSecret: "app_secret", brand: "feishu" },
      { fetch }
    );
    const [, authInit] = fetch.mock.calls[0];
    const authBody = new URLSearchParams(authInit?.body as string);

    expect(fetch.mock.calls[0][0]).toBe("https://accounts.feishu.cn/oauth/v1/device_authorization");
    expect(authInit?.headers).toMatchObject({ authorization: `Basic ${basic}` });
    expect(authBody.get("scope")).toBe("offline_access");

    const tokenResult = pollLarkDeviceToken(
      {
        appId: "cli_app",
        appSecret: "app_secret",
        brand: "feishu",
        deviceCode: authorization.deviceCode,
        interval: authorization.interval,
        expiresIn: authorization.expiresIn
      },
      { fetch }
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(tokenResult).resolves.toMatchObject({ accessToken: "user-token", refreshToken: "refresh-token" });
    const [, tokenInit] = fetch.mock.calls[1];
    const tokenBody = new URLSearchParams(tokenInit?.body as string);

    expect(fetch.mock.calls[1][0]).toBe("https://open.feishu.cn/open-apis/authen/v2/oauth/token");
    expect(tokenBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(tokenBody.get("device_code")).toBe("device-1");
    expect(tokenBody.get("client_id")).toBe("cli_app");
    expect(tokenBody.get("client_secret")).toBe("app_secret");

    await expect(getLarkBrowserUserInfo({ accessToken: "user-token", brand: "feishu" }, { fetch })).resolves.toEqual({
      openId: "ou_owner",
      name: "Owner"
    });
    expect(fetch.mock.calls[2][0]).toBe("https://open.feishu.cn/open-apis/authen/v1/user_info");
    expect(fetch.mock.calls[2][1]?.headers).toMatchObject({ authorization: "Bearer user-token" });
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
