import { describe, expect, it } from "vitest";
import { buildThreadForkParams, buildThreadResumeParams, buildThreadStartParams } from "./thread.js";

describe("codex thread payloads", () => {
  it("builds thread/start with Twinny's thread runtime overrides", () => {
    expect(buildThreadStartParams({ cwd: "/tmp/twinny/workspaces/p2p_ou_1" })).toEqual({
      cwd: "/tmp/twinny/workspaces/p2p_ou_1",
      approvalPolicy: "never",
      persistExtendedHistory: true
    });
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
});
