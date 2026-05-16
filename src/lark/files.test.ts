import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantAccessTokenManager } from "./auth.js";
import { LarkFileDownloader } from "./files.js";
import { LarkOpenApiClient } from "./openapi.js";
import type { FetchLike } from "./types.js";

describe("LarkFileDownloader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-lark-files-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("downloads a message resource to the requested output directory", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      binaryResponse("hello", {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="report.txt"'
      })
    ]);
    const downloader = createDownloader(fetch);

    const downloaded = await downloader.downloadMessageResource({
      messageId: "om_1",
      resourceType: "file",
      fileKey: "file_1",
      outputDir: tempDir
    });

    expect(downloaded).toMatchObject({
      path: path.join(tempDir, "report.txt"),
      resourceType: "file",
      fileKey: "file_1",
      fileName: "report.txt",
      contentType: "text/plain"
    });
    expect(fs.readFileSync(downloaded.path, "utf8")).toBe("hello");
    expect(fetch).toHaveBeenLastCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_1/resources/file_1?type=file",
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

  it("adds numeric suffixes when the resolved local filename already exists", async () => {
    fs.writeFileSync(path.join(tempDir, "report.txt"), "existing");
    fs.writeFileSync(path.join(tempDir, "report(2).txt"), "existing 2");
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      binaryResponse("new", {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="report.txt"'
      })
    ]);
    const downloader = createDownloader(fetch);

    const downloaded = await downloader.downloadMessageResource({
      messageId: "om_1",
      resourceType: "file",
      fileKey: "file_1",
      outputDir: tempDir
    });

    expect(downloaded).toMatchObject({
      path: path.join(tempDir, "report(3).txt"),
      fileName: "report(3).txt"
    });
    expect(fs.readFileSync(downloaded.path, "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(tempDir, "report.txt"), "utf8")).toBe("existing");
    expect(fs.readFileSync(path.join(tempDir, "report(2).txt"), "utf8")).toBe("existing 2");
  });
});

function createDownloader(fetch: FetchLike) {
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
  return new LarkFileDownloader({ openApiClient });
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

function binaryResponse(body: string, headers: Record<string, string>) {
  const normalizedHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const buffer = Buffer.from(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (name: string) => normalizedHeaders.get(name.toLowerCase()) ?? null
    },
    json: async () => ({}),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  };
}

function isFetchResponse(value: unknown): value is Awaited<ReturnType<FetchLike>> {
  return Boolean(value && typeof value === "object" && "ok" in value && "status" in value && "json" in value);
}
