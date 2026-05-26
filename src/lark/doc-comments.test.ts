import { describe, expect, it, vi } from "vitest";

import { LarkDocClient } from "./doc-comments.js";
import { LarkOpenApiError, type LarkOpenApiClient } from "./openapi.js";

describe("LarkDocClient", () => {
  it("resolves direct doc URLs without OpenAPI calls", async () => {
    const openApiClient = createOpenApiClient();
    const client = new LarkDocClient({ openApiClient });

    await expect(client.resolveDocTarget("https://example.feishu.cn/docs/doc_token")).resolves.toEqual({
      fileType: "doc",
      fileToken: "doc_token",
      watchUrl: "https://example.feishu.cn/docs/doc_token"
    });
    await expect(client.resolveDocTarget("https://example.feishu.cn/sheets/sheet_token")).resolves.toMatchObject({
      fileType: "sheet",
      fileToken: "sheet_token"
    });
    await expect(client.resolveDocTarget("https://example.feishu.cn/base/base_token")).resolves.toMatchObject({
      fileType: "bitable",
      fileToken: "base_token"
    });
    expect(openApiClient.request).not.toHaveBeenCalled();
  });

  it("resolves wiki URLs through get_node to the backing file", async () => {
    const openApiClient = createOpenApiClient({
      request: vi.fn(async () => ({
        data: {
          node: {
            obj_type: "docx",
            obj_token: "docx_token"
          }
        }
      }))
    });
    const client = new LarkDocClient({ openApiClient });

    await expect(client.resolveDocTarget("https://example.feishu.cn/wiki/wiki_token")).resolves.toEqual({
      fileType: "docx",
      fileToken: "docx_token",
      watchUrl: "https://example.feishu.cn/wiki/wiki_token"
    });
    expect(openApiClient.request).toHaveBeenCalledWith("/wiki/v2/spaces/get_node", {
      method: "GET",
      query: { token: "wiki_token" }
    });
  });

  it("refreshes a comment snapshot from batch_query and replies.list", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/comments/batch_query")) {
        return {
          data: {
            items: [
              {
                comment_id: "comment_1",
                user_id: "ou_root",
                quote: "quoted text",
                is_done: false,
                is_whole: false
              }
            ]
          }
        };
      }
      return {
        data: {
          items: [
            {
              reply_id: "reply_old",
              user_id: "ou_old",
              create_time: 1000,
              content: { text: "old" }
            },
            {
              reply_id: "reply_1",
              user_id: "ou_reply",
              create_time: 2000,
              content: {
                elements: [
                  { type: "text_run", text_run: { text: "hello " } },
                  { type: "person", person: { name: "Twinny" } }
                ]
              },
              extra: {
                image_list: ["img_1", { image_key: "img_2" }]
              }
            }
          ]
        }
      };
    });
    const client = new LarkDocClient({ openApiClient: createOpenApiClient({ request }) });

    await expect(
      client.getCommentSnapshot({
        fileType: "docx",
        fileToken: "doc_token",
        commentId: "comment_1",
        replyId: "reply_1"
      })
    ).resolves.toMatchObject({
      fileType: "docx",
      fileToken: "doc_token",
      commentId: "comment_1",
      replyId: "reply_1",
      authorOpenId: "ou_reply",
      text: "hello @Twinny",
      quote: "quoted text",
      imageKeys: ["img_1", "img_2"],
      isDone: false,
      isSolved: false,
      isWhole: false,
      createTime: 2000
    });
    expect(request).toHaveBeenCalledWith(
      "/drive/v1/files/doc_token/comments/batch_query",
      expect.objectContaining({
        method: "POST",
        query: expect.objectContaining({ file_type: "docx" }),
        body: { comment_ids: ["comment_1"], need_reaction: true }
      })
    );
    expect(request).toHaveBeenCalledWith(
      "/drive/v1/files/doc_token/comments/comment_1/replies",
      expect.objectContaining({
        method: "GET",
        query: expect.objectContaining({ file_type: "docx", need_reaction: true })
      })
    );
  });

  it("retries comment snapshot reads when Lark has not exposed a freshly mentioned comment yet", async () => {
    let batchQueryCalls = 0;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/comments/batch_query")) {
        batchQueryCalls += 1;
        if (batchQueryCalls === 1) {
          throw new LarkOpenApiError("comment permission not ready", {
            status: 400,
            code: 1069301,
            responseBody: { code: 1069301, msg: "fail" },
            retryable: false
          });
        }
        return {
          data: {
            items: [
              {
                comment_id: "comment_1",
                user_id: "ou_reviewer",
                quote: "quoted text",
                is_solved: false,
                is_whole: false
              }
            ]
          }
        };
      }
      return {
        data: {
          items: [
            {
              reply_id: "reply_1",
              user_id: "ou_reviewer",
              create_time: 2000,
              content: { text: "@Twinny please check" }
            }
          ]
        }
      };
    });
    const sleep = vi.fn(async () => undefined);
    const client = new LarkDocClient({
      openApiClient: createOpenApiClient({ request }),
      commentReadMaxRetries: 2,
      commentReadRetryBaseDelayMs: 25,
      sleep
    });

    await expect(
      client.getCommentSnapshot({
        fileType: "docx",
        fileToken: "doc_token",
        commentId: "comment_1",
        replyId: "reply_1"
      })
    ).resolves.toMatchObject({
      authorOpenId: "ou_reviewer",
      text: "@Twinny please check"
    });
    expect(batchQueryCalls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("uses the whole-comment create endpoint when replying to global comments", async () => {
    const request = vi.fn(async () => ({
      data: {
        reply_list: {
          replies: [{ reply_id: "reply_created" }]
        }
      }
    }));
    const client = new LarkDocClient({ openApiClient: createOpenApiClient({ request }) });

    await expect(
      client.replyToComment({
        fileType: "docx",
        fileToken: "doc_token",
        commentId: "comment_1",
        isWhole: true,
        text: "done"
      })
    ).resolves.toMatchObject({ replyId: "reply_created" });
    expect(request).toHaveBeenCalledWith(
      "/drive/v1/files/doc_token/comments",
      expect.objectContaining({
        method: "POST",
        query: { file_type: "docx" },
        body: {
          comment_id: "comment_1",
          reply_list: {
            replies: [
              {
                content: {
                  elements: [
                    {
                      type: "text_run",
                      text_run: { text: "done" }
                    }
                  ]
                }
              }
            ]
          }
        }
      })
    );
  });
});

function createOpenApiClient(overrides: Partial<LarkOpenApiClient> = {}): LarkOpenApiClient {
  return {
    request: vi.fn(async () => ({ data: {} })),
    download: vi.fn(async () => ({
      body: Buffer.from(""),
      contentType: undefined,
      contentDisposition: undefined
    })),
    ...overrides
  } as unknown as LarkOpenApiClient;
}
