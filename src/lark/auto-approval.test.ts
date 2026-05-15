import { describe, expect, it, vi } from "vitest";
import { LarkAutoApprovalWorker } from "./auto-approval.js";
import type { LarkApprovalClient, LarkApprovalTask } from "./approval.js";

describe("LarkAutoApprovalWorker", () => {
  it("approves only matching app access requests and skips unsupported tasks", async () => {
    const tasks: LarkApprovalTask[] = [
      task("inst-match", "task-match"),
      task("inst-other-app", "task-other-app"),
      task("inst-other-definition", "task-other-definition"),
      { ...task("inst-unsupported", "task-unsupported"), supportApiOperate: false }
    ];
    const approvalClient = {
      listTodoTasks: vi.fn(async () => tasks),
      getInstance: vi.fn(async (instanceCode: string) => ({
        definitionCode: instanceCode === "inst-other-definition" ? "other-def" : "def",
        instanceCode,
        form: [
          {
            name: "应用详情",
            value:
              instanceCode === "inst-match"
                ? "https://thebytedance.feishu.cn/admin/appCenter/manage/cli_target"
                : "https://thebytedance.feishu.cn/admin/appCenter/manage/cli_other",
            raw: {}
          }
        ],
        raw: {}
      })),
      approveTask: vi.fn(async () => undefined)
    };
    const worker = new LarkAutoApprovalWorker({
      approvalClient: approvalClient as unknown as LarkApprovalClient,
      appId: "cli_target",
      definitionCode: "def",
      pollIntervalMs: 60_000
    });

    await expect(worker.runOnce()).resolves.toEqual({ scanned: 4, approved: 1, skipped: 3, failed: 0 });
    expect(approvalClient.listTodoTasks).toHaveBeenCalledWith({ signal: undefined });
    expect(approvalClient.approveTask).toHaveBeenCalledOnce();
    expect(approvalClient.approveTask).toHaveBeenCalledWith(
      expect.objectContaining({ instanceCode: "inst-match", taskId: "task-match" })
    );
    expect(approvalClient.getInstance).toHaveBeenCalledTimes(3);
  });

  it("continues processing after one task fails", async () => {
    const approvalClient = {
      listTodoTasks: vi.fn(async () => [task("inst-fail", "task-fail"), task("inst-ok", "task-ok")]),
      getInstance: vi.fn(async (instanceCode: string) => {
        if (instanceCode === "inst-fail") {
          throw new Error("detail failed");
        }
        return {
          definitionCode: "def",
          instanceCode,
          form: [{ name: "应用详情", value: "cli_target", raw: {} }],
          raw: {}
        };
      }),
      approveTask: vi.fn(async () => undefined)
    };
    const worker = new LarkAutoApprovalWorker({
      approvalClient: approvalClient as unknown as LarkApprovalClient,
      appId: "cli_target",
      definitionCode: "def",
      pollIntervalMs: 60_000,
      logger: { warn: vi.fn() }
    });

    await expect(worker.runOnce()).resolves.toEqual({ scanned: 2, approved: 1, skipped: 0, failed: 1 });
    expect(approvalClient.approveTask).toHaveBeenCalledWith(expect.objectContaining({ instanceCode: "inst-ok" }));
  });
});

function task(instanceCode: string, taskId: string): LarkApprovalTask {
  return {
    definitionCode: "def",
    instanceCode,
    taskId,
    raw: {}
  };
}
