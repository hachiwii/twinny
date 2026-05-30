import { describe, expect, it } from "vitest";
import { buildThreadForkParams, buildThreadResumeParams, buildThreadStartParams } from "./thread.js";

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
        expect.objectContaining({ namespace: "twinny", name: "new_thread", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "wait_for_threads", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "send_thread_ref", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "tell_thread", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "add_cron", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "list_cron", deferLoading: false }),
        expect.objectContaining({ namespace: "twinny", name: "del_cron", deferLoading: false }),
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
    expect(buildThreadStartParams({ cwd: "/tmp/twinny/workspaces/p2p_ou_1" }).dynamicTools).toHaveLength(10);
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
});
