import { describe, expect, it, vi } from "vitest";
import type { CodexNotificationMessage, CodexProtocolClient } from "./protocol.js";
import {
  buildThreadForkParams,
  buildThreadResumeParams,
  buildThreadStartParams,
  rollbackCodexThread
} from "./thread.js";

describe("codex thread payloads", () => {
  it("builds thread/start with Twinny's thread runtime overrides", () => {
    expect(buildThreadStartParams({ cwd: "/tmp/twinny/workspaces/p2p_ou_1" })).toEqual({
      cwd: "/tmp/twinny/workspaces/p2p_ou_1",
      approvalPolicy: "never",
      persistExtendedHistory: true,
      dynamicTools: expect.arrayContaining([
        expect.objectContaining({
          namespace: "twinny",
          name: "set_thread_name",
          description: expect.stringContaining("15 Chinese characters or 10 words"),
          inputSchema: expect.objectContaining({
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: expect.objectContaining({
              name: {
                type: "string",
                minLength: 1,
                description: expect.stringContaining("15 Chinese characters or 10 words")
              }
            })
          }),
          deferLoading: false
        }),
        expect.objectContaining({ namespace: "twinny", name: "list_threads", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "search_threads", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "new_thread", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "wait_for_threads", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "send_thread_ref", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "tell_thread", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "add_cron", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "list_cron", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "del_cron", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "watch_lark_url", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "list_lark_url_watchers", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "rm_lark_url_watchers", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "create_conversation", deferLoading: false })
      ])
    });
    const tool = buildThreadStartParams({ cwd: "/tmp/twinny/workspaces/p2p_ou_1" }).dynamicTools[0]!;
    expect(JSON.stringify(tool.inputSchema)).not.toContain("maxLength");
    expect(tool.description).not.toContain("Twinny");
    const waitTool = buildThreadStartParams({ cwd: "/tmp/twinny/workspaces/p2p_ou_1" }).dynamicTools.find((candidate) =>
      candidate.namespace === "twinny" && candidate.name === "wait_for_threads"
    );
    expect(waitTool).toMatchObject({
      description: expect.stringContaining("timeout_ms: 0"),
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          timeout_ms: expect.objectContaining({ minimum: 0 })
        })
      })
    });
    const searchTool = buildThreadStartParams({ cwd: "/tmp/twinny/workspaces/p2p_ou_1" }).dynamicTools.find((candidate) =>
      candidate.namespace === "twinny" && candidate.name === "search_threads"
    );
    expect(searchTool).toMatchObject({
      inputSchema: expect.objectContaining({
        required: ["searchTerm"],
        properties: expect.objectContaining({
          searchTerm: expect.objectContaining({ type: "string", minLength: 1 }),
          cursor: expect.objectContaining({ type: ["string", "null"] }),
          limit: expect.objectContaining({ type: ["integer", "null"], minimum: 1, maximum: 100 }),
          sortKey: expect.objectContaining({ enum: ["created_at", "updated_at", null] }),
          sortDirection: expect.objectContaining({ enum: ["asc", "desc", null] })
        })
      })
    });
    expect(JSON.stringify(searchTool?.inputSchema)).not.toContain("sourceKinds");
    expect(JSON.stringify(searchTool?.inputSchema)).not.toContain("archived");
    const tellTool = buildThreadStartParams({ cwd: "/tmp/twinny/workspaces/p2p_ou_1" }).dynamicTools.find((candidate) =>
      candidate.namespace === "twinny" && candidate.name === "tell_thread"
    );
    expect(tellTool).toMatchObject({
      description: expect.stringContaining("mode defaults to queue"),
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          mode: expect.objectContaining({
            enum: ["queue", "steer", "interrupt"],
            default: "queue"
          })
        })
      })
    });
    const addCronTool = buildThreadStartParams({ cwd: "/tmp/twinny/workspaces/p2p_ou_1" }).dynamicTools.find((candidate) =>
      candidate.namespace === "twinny" && candidate.name === "add_cron"
    );
    expect(addCronTool).toMatchObject({
      description: expect.stringContaining("Set as_goal only when the user explicitly asks"),
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          as_goal: expect.objectContaining({
            type: "boolean",
            default: false,
            description: expect.stringContaining("Only set this when the user explicitly asks")
          })
        })
      })
    });
    const watchTool = buildThreadStartParams({ cwd: "/tmp/twinny/workspaces/p2p_ou_1" }).dynamicTools.find((candidate) =>
      candidate.namespace === "twinny" && candidate.name === "watch_lark_url"
    );
    expect(watchTool).toMatchObject({
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          mode: expect.objectContaining({ enum: ["owner", "all"], default: "owner" }),
          file_type: expect.objectContaining({ type: "string" }),
          file_token: expect.objectContaining({ type: "string" })
        })
      })
    });
    expect(buildThreadStartParams({ cwd: "/tmp/twinny/workspaces/p2p_ou_1" }).dynamicTools).toHaveLength(14);
  });

  it("builds thread/resume with the persisted thread id and the same thread overrides", () => {
    expect(buildThreadResumeParams("thread_123", { cwd: "/tmp/twinny/workspaces/p2p_ou_1" })).toEqual({
      threadId: "thread_123",
      cwd: "/tmp/twinny/workspaces/p2p_ou_1",
      approvalPolicy: "never",
      persistExtendedHistory: true
    });
  });

  it("includes optional thread/start developer instructions", () => {
    expect(
      buildThreadStartParams({
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        developerInstructions: "Twinny context"
      })
    ).toMatchObject({
      developerInstructions: "Twinny context"
    });
  });

  it("builds thread/fork with the persisted thread id and lightweight response payload", () => {
    expect(buildThreadForkParams("thread_123", { cwd: "/tmp/twinny/workspaces/p2p_ou_1" })).toEqual({
      threadId: "thread_123",
      cwd: "/tmp/twinny/workspaces/p2p_ou_1",
      approvalPolicy: "never",
      persistExtendedHistory: true,
      excludeTurns: true
    });
  });

  it("builds ephemeral side thread/fork with side instructions and no persistence", () => {
    expect(
      buildThreadForkParams("thread_123", {
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        ephemeral: true,
        developerInstructions: "side instructions",
        model: "gpt-5.5",
        effort: "medium"
      })
    ).toEqual({
      threadId: "thread_123",
      cwd: "/tmp/twinny/workspaces/p2p_ou_1",
      approvalPolicy: "never",
      persistExtendedHistory: false,
      excludeTurns: true,
      ephemeral: true,
      developerInstructions: "side instructions",
      model: "gpt-5.5",
      config: { model_reasoning_effort: "medium" }
    });
  });

  it("rolls back a thread and captures the matching token usage notification", async () => {
    const notificationListeners = new Set<(message: CodexNotificationMessage) => void>();
    const request = vi.fn(async (method: string, params: unknown) => {
      queueMicrotask(() => {
        for (const listener of notificationListeners) {
          listener({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread_123",
              turnId: "turn_1",
              tokenUsage: {
                total: { totalTokens: 42 },
                last: { totalTokens: 21 }
              }
            }
          });
        }
      });
      return { thread: { id: "thread_123", turns: [] } };
    });
    const protocol = {
      request,
      on: vi.fn((event: string, listener: (message: CodexNotificationMessage) => void) => {
        if (event === "notification") {
          notificationListeners.add(listener);
        }
        return protocol;
      }),
      off: vi.fn((event: string, listener: (message: CodexNotificationMessage) => void) => {
        if (event === "notification") {
          notificationListeners.delete(listener);
        }
        return protocol;
      })
    } as unknown as CodexProtocolClient;

    await expect(rollbackCodexThread(protocol, { threadId: "thread_123", numTurns: 2 })).resolves.toMatchObject({
      thread: { id: "thread_123" },
      tokenUsage: {
        threadId: "thread_123",
        turnId: "turn_1",
        totalTokens: 42
      }
    });
    expect(request).toHaveBeenCalledWith("thread/rollback", { threadId: "thread_123", numTurns: 2 });
    expect(protocol.off).toHaveBeenCalledWith("notification", expect.any(Function));
  });
});
