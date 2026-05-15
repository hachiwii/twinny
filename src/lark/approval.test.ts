import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUTO_APPROVAL_COMMENT,
  extractApprovalAppId,
  isAppAccessApprovalInstance,
  LarkApprovalClient,
  parseApprovalForm
} from "./approval.js";
import { LarkOpenApiClient } from "./openapi.js";
import type { FetchLike } from "./types.js";

describe("approval form matching", () => {
  it("matches app access approvals by definition code and exact app id extracted from 应用详情", () => {
    const form = parseApprovalForm(
      JSON.stringify([
        { id: "widget1", name: "应用名称", value: "曹浩威 Pro" },
        {
          id: "widget2",
          name: "应用详情",
          value: "https://thebytedance.feishu.cn/admin/appCenter/manage/cli_a955176022381cc4"
        }
      ])
    );

    expect(extractApprovalAppId(form)).toBe("cli_a955176022381cc4");
    expect(
      isAppAccessApprovalInstance(
        { definitionCode: "definition-1", form },
        { definitionCode: "definition-1", appId: "cli_a955176022381cc4" }
      )
    ).toBe(true);
    expect(
      isAppAccessApprovalInstance(
        { definitionCode: "definition-1", form },
        { definitionCode: "definition-2", appId: "cli_a955176022381cc4" }
      )
    ).toBe(false);
    expect(
      isAppAccessApprovalInstance(
        { definitionCode: "definition-1", form },
        { definitionCode: "definition-1", appId: "cli_a955176022381cc" }
      )
    ).toBe(false);
  });

  it("supports array form data and ignores missing detail fields", () => {
    expect(parseApprovalForm([{ name: "应用详情", value: "cli_app" }])).toHaveLength(1);
    expect(extractApprovalAppId(parseApprovalForm([{ name: "应用名称", value: "cli_app" }]))).toBeUndefined();
    expect(parseApprovalForm("not json")).toEqual([]);
  });
});

describe("LarkApprovalClient", () => {
  it("lists paginated todo tasks without pre-filtering by definition code", async () => {
    const fetch = sequenceFetch([
      { code: 0, data: { tasks: [{ definition_code: "def", instance_code: "inst-1", task_id: "task-1" }], has_more: true, page_token: "next" } },
      { code: 0, data: { tasks: [{ definition_code: "def", instance_code: "inst-2", task_id: "task-2", support_api_operate: false }], has_more: false } }
    ]);
    const client = createApprovalClient(fetch);

    await expect(client.listTodoTasks({ pageSize: 50 })).resolves.toMatchObject([
      { definitionCode: "def", instanceCode: "inst-1", taskId: "task-1" },
      { definitionCode: "def", instanceCode: "inst-2", taskId: "task-2", supportApiOperate: false }
    ]);

    expect(fetch).toHaveBeenNthCalledWith(1, "https://open.feishu.cn/open-apis/approval/v4/tasks?topic=1&page_size=50", expect.anything());
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/approval/v4/tasks?topic=1&page_size=50&page_token=next",
      expect.anything()
    );
  });

  it("gets instance details and approves tasks", async () => {
    const fetch = sequenceFetch([
      {
        code: 0,
        data: {
          definition_code: "def",
          instance_code: "inst-1",
          form: JSON.stringify([{ name: "应用详情", value: "cli_app" }])
        }
      },
      { code: 0, data: {} }
    ]);
    const client = createApprovalClient(fetch);

    await expect(client.getInstance("inst-1")).resolves.toMatchObject({
      definitionCode: "def",
      instanceCode: "inst-1",
      form: [{ name: "应用详情", value: "cli_app" }]
    });
    await client.approveTask({ instanceCode: "inst-1", taskId: "task-1" });

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/approval/v4/tasks/pass",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          instance_code: "inst-1",
          task_id: "task-1",
          comment: DEFAULT_AUTO_APPROVAL_COMMENT
        })
      })
    );
  });
});

function createApprovalClient(fetch: FetchLike): LarkApprovalClient {
  return new LarkApprovalClient({
    openApiClient: new LarkOpenApiClient({
      accessTokenProvider: { getAccessToken: async () => "user-token" },
      fetch,
      retryBaseDelayMs: 0
    })
  });
}

function sequenceFetch(bodies: unknown[]): FetchLike {
  return vi.fn(async () => {
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
}
