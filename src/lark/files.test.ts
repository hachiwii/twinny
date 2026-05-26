import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantAccessTokenManager } from "./auth.js";
import { LarkFileDownloader } from "./files.js";
import { LarkOpenApiClient, LarkOpenApiError } from "./openapi.js";
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
      size: 5,
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

  it("uploads a local image as a message image", async () => {
    const imagePath = path.join(tempDir, "result.png");
    fs.writeFileSync(imagePath, "png");
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { image_key: "img_uploaded" } }
    ]);
    const downloader = createDownloader(fetch);

    await expect(downloader.uploadImage({ filePath: imagePath })).resolves.toMatchObject({
      imageKey: "img_uploaded"
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/images", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token"
      },
      body: expect.any(FormData),
      signal: undefined
    });
  });

  it("uploads a local file with a matching Lark file type", async () => {
    const filePath = path.join(tempDir, "report.pdf");
    fs.writeFileSync(filePath, "pdf");
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      { code: 0, data: { file_key: "file_uploaded" } }
    ]);
    const downloader = createDownloader(fetch);

    await expect(downloader.uploadFile({ filePath })).resolves.toMatchObject({
      fileKey: "file_uploaded"
    });

    expect(fetch).toHaveBeenLastCalledWith("https://open.feishu.cn/open-apis/im/v1/files", {
      method: "POST",
      headers: {
        authorization: "Bearer tenant-token"
      },
      body: expect.any(FormData),
      signal: undefined
    });
  });

  it("preserves JSON error details for failed binary downloads", async () => {
    const fetch = sequenceFetch([
      { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
      jsonErrorResponse({
        code: 99991672,
        msg: "Permission denied",
        error: {
          permission_violations: [
            { subject: "docs:document.media:download", type: "action_scope_required" }
          ]
        }
      })
    ]);
    const openApiClient = createOpenApiClient(fetch);

    await expect(
      openApiClient.download("/drive/v1/medias/image_token/download")
    ).rejects.toMatchObject({
      name: "LarkOpenApiError",
      detail: {
        status: 400,
        code: 99991672,
        responseBody: {
          code: 99991672,
          error: {
            permission_violations: [
              { subject: "docs:document.media:download" }
            ]
          }
        },
        retryable: false
      }
    } satisfies Partial<LarkOpenApiError>);
  });
});

function createDownloader(fetch: FetchLike) {
  return new LarkFileDownloader({ openApiClient: createOpenApiClient(fetch) });
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

function jsonErrorResponse(body: unknown) {
  const text = JSON.stringify(body);
  return {
    ok: false,
    status: 400,
    statusText: "Bad Request",
    headers: {
      get: () => "application/json"
    },
    json: async () => body,
    text: async () => text
  };
}

function isFetchResponse(value: unknown): value is Awaited<ReturnType<FetchLike>> {
  return Boolean(value && typeof value === "object" && "ok" in value && "status" in value && "json" in value);
}
