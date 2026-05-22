import { describe, expect, it } from "vitest";
import { buildThreadForkParams, buildThreadResumeParams, buildThreadStartParams } from "./thread.js";

describe("codex thread payloads", () => {
  it("builds thread/start with Twinny's thread runtime overrides", () => {
    expect(buildThreadStartParams({ cwd: "/tmp/twinny/workspaces/p2p_ou_1" })).toEqual({
      cwd: "/tmp/twinny/workspaces/p2p_ou_1",
      approvalPolicy: "never",
      persistExtendedHistory: true,
      dynamicTools: [
        {
          namespace: "twinny",
          name: "set_thread_name",
          description: expect.stringContaining("15 Chinese characters or 10 words"),
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
              name: {
                type: "string",
                minLength: 1,
                description: expect.stringContaining("15 Chinese characters or 10 words")
              }
            }
          },
          deferLoading: false
        }
      ]
    });
    const tool = buildThreadStartParams({ cwd: "/tmp/twinny/workspaces/p2p_ou_1" }).dynamicTools[0]!;
    expect(JSON.stringify(tool.inputSchema)).not.toContain("maxLength");
    expect(tool.description).not.toContain("Twinny");
  });

  it("builds thread/resume with the persisted thread id and the same thread overrides", () => {
    expect(buildThreadResumeParams("thread_123", { cwd: "/tmp/twinny/workspaces/p2p_ou_1" })).toEqual({
      threadId: "thread_123",
      cwd: "/tmp/twinny/workspaces/p2p_ou_1",
      approvalPolicy: "never",
      persistExtendedHistory: true
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
