import { describe, expect, it, vi } from "vitest";
import { TenantAccessTokenManager } from "./auth.js";
import { LarkOpenApiClient, type LarkOpenApiError } from "./openapi.js";
import type { FetchLike } from "./types.js";

describe("LarkOpenApiClient", () => {
  it("preserves non-JSON failure bodies instead of leaking JSON parser errors", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      textResponse(404, "Not Found", "404 page not found")
    ]);
    const client = createOpenApiClient(fetch);

    await expect(client.request("/im/v1/chats/oc_project/link", { method: "GET" })).rejects.toMatchObject({
      name: "LarkOpenApiError",
      message: "Lark OpenAPI request failed: status=404 code=unknown msg=Not Found",
      detail: {
        status: 404,
        responseBody: { raw: "404 page not found" },
        retryable: false
      }
    } satisfies Partial<LarkOpenApiError>);
  });
});

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

function sequenceFetch(responses: unknown[]): FetchLike {
  const fetch = vi.fn(async () => {
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("unexpected fetch call");
    }
    if (isFetchResponse(response)) {
      return response;
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => response
    };
  });
  return fetch;
}

function textResponse(status: number, statusText: string, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => {
      throw new SyntaxError("Unexpected non-whitespace character after JSON at position 4");
    },
    text: async () => body
  };
}

function isFetchResponse(value: unknown): value is Awaited<ReturnType<FetchLike>> {
  return Boolean(value && typeof value === "object" && "ok" in value && "status" in value && "json" in value);
}
