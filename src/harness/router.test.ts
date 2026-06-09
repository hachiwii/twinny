import { describe, expect, it, vi } from "vitest";
import type { CodexBridge } from "../conversation/manager.js";
import type { HarnessKind } from "../types.js";
import type { ClaudeCodeHarness } from "./claude.js";
import { createHarnessRouter } from "./router.js";

function createCodexBridge(): CodexBridge {
  return {
    startThread: vi.fn(async () => ({ threadId: "codex_thread" })),
    resumeThread: vi.fn(async ({ threadId }) => ({ threadId })),
    forkThread: vi.fn(async ({ threadId }) => ({ threadId: `${threadId}_fork` })),
    injectThreadItems: vi.fn(async () => undefined),
    unsubscribeThread: vi.fn(async () => undefined),
    startTurn: vi.fn(async ({ threadId }) => ({ threadId, text: "codex", status: "completed" as const })),
    compactThread: vi.fn(async ({ threadId }) => ({ threadId, text: "", status: "completed" as const })),
    steerTurn: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
    rollbackThread: vi.fn(async ({ threadId }) => ({ thread: { id: threadId, turns: [] } })),
    readCodexVersion: vi.fn(() => "codex 1.0"),
    readAccountRateLimits: vi.fn(async () => ({ ok: true })),
    getThreadGoal: vi.fn(async () => null),
    clearThreadGoal: vi.fn(async () => undefined),
    setThreadName: vi.fn(async () => undefined)
  } as unknown as CodexBridge;
}

function createClaudeBridge(): ClaudeCodeHarness {
  return {
    startThread: vi.fn(async () => ({ threadId: "claude_thread" })),
    resumeThread: vi.fn(async ({ threadId }: { threadId: string }) => ({ threadId })),
    forkThread: vi.fn(async () => ({ threadId: "claude_fork" })),
    injectThreadItems: vi.fn(async () => undefined),
    unsubscribeThread: vi.fn(async () => undefined),
    startTurn: vi.fn(async ({ threadId }: { threadId: string }) => ({
      threadId,
      text: "claude",
      status: "completed" as const
    })),
    compactThread: vi.fn(async ({ threadId }: { threadId: string }) => ({
      threadId,
      text: "",
      status: "completed" as const
    })),
    steerTurn: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined)
  } as unknown as ClaudeCodeHarness;
}

function createRouter(options: {
  defaultHarness?: HarnessKind;
  persisted?: Record<string, HarnessKind>;
} = {}) {
  const codex = createCodexBridge();
  const claude = createClaudeBridge();
  const router = createHarnessRouter({
    codex,
    claude,
    defaultHarness: options.defaultHarness ?? "codex",
    resolveThreadHarness: (threadId) => options.persisted?.[threadId]
  });
  return { codex, claude, router };
}

describe("createHarnessRouter", () => {
  it("starts threads on the default harness when none is requested", async () => {
    const { codex, claude, router } = createRouter();
    const result = await router.startThread({ profile: "host", cwd: "/tmp", approvalPolicy: "never" });
    expect(result.threadId).toBe("codex_thread");
    expect(codex.startThread).toHaveBeenCalledTimes(1);
    expect(claude.startThread).not.toHaveBeenCalled();
    expect(router.threadHarness?.("codex_thread")).toBe("codex");
  });

  it("starts threads on claude when requested and routes follow-up calls by thread id", async () => {
    const { codex, claude, router } = createRouter();
    const result = await router.startThread({ profile: "host", cwd: "/tmp", approvalPolicy: "never", harness: "claude" });
    expect(result.threadId).toBe("claude_thread");
    expect(router.threadHarness?.("claude_thread")).toBe("claude");

    await router.startTurn({ profile: "host", threadId: "claude_thread", input: "hi", cwd: "/tmp", approvalPolicy: "never" });
    expect(claude.startTurn).toHaveBeenCalledTimes(1);
    expect(codex.startTurn).not.toHaveBeenCalled();

    await router.steerTurn({ profile: "host", threadId: "claude_thread", turnId: "t", input: "x", cwd: "/tmp", approvalPolicy: "never" });
    await router.interruptTurn({ profile: "host", threadId: "claude_thread", turnId: "t" });
    await router.compactThread({ profile: "host", threadId: "claude_thread", cwd: "/tmp", approvalPolicy: "never" });
    expect(claude.steerTurn).toHaveBeenCalledTimes(1);
    expect(claude.interruptTurn).toHaveBeenCalledTimes(1);
    expect(claude.compactThread).toHaveBeenCalledTimes(1);
  });

  it("uses the configured default harness for new threads", async () => {
    const { claude, router } = createRouter({ defaultHarness: "claude" });
    const result = await router.startThread({ profile: "host", cwd: "/tmp", approvalPolicy: "never" });
    expect(result.threadId).toBe("claude_thread");
    expect(claude.startThread).toHaveBeenCalledTimes(1);
  });

  it("resolves persisted thread harness for threads created before this process", async () => {
    const { claude, codex, router } = createRouter({ persisted: { old_claude: "claude" } });
    await router.startTurn({ profile: "host", threadId: "old_claude", input: "hi", cwd: "/tmp", approvalPolicy: "never" });
    expect(claude.startTurn).toHaveBeenCalledTimes(1);

    await router.startTurn({ profile: "host", threadId: "old_codex", input: "hi", cwd: "/tmp", approvalPolicy: "never" });
    expect(codex.startTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps forks on the source thread harness", async () => {
    const { claude, router } = createRouter({ persisted: { claude_main: "claude" } });
    const fork = await router.forkThread({ profile: "host", threadId: "claude_main", cwd: "/tmp", approvalPolicy: "never" });
    expect(claude.forkThread).toHaveBeenCalledTimes(1);
    expect(fork.threadId).toBe("claude_fork");
    expect(router.threadHarness?.("claude_fork")).toBe("claude");

    await router.injectThreadItems?.({ profile: "host", threadId: "claude_fork", items: [] });
    expect(claude.injectThreadItems).toHaveBeenCalledTimes(1);
  });

  it("rejects claude threads for codex-only capabilities with typed errors", async () => {
    const { router } = createRouter({ persisted: { c1: "claude" } });
    await expect(router.rollbackThread?.({ profile: "host", threadId: "c1", numTurns: 1 })).rejects.toThrow(
      /Claude Code harness 不支持/
    );
    await expect(
      router.runGoal?.({ profile: "host", threadId: "c1", cwd: "/tmp", objective: "x" })
    ).rejects.toThrow(/goal/);
    await expect(router.readThread?.({ profile: "host", threadId: "c1" })).rejects.toThrow(/thread 历史/);
  });

  it("degrades goal reads and thread naming to safe no-ops on claude threads", async () => {
    const { codex, router } = createRouter({ persisted: { c1: "claude" } });
    await expect(router.getThreadGoal?.({ profile: "host", threadId: "c1" })).resolves.toBeNull();
    await expect(router.clearThreadGoal?.({ profile: "host", threadId: "c1" })).resolves.toBeUndefined();
    await expect(router.setThreadName?.({ profile: "host", threadId: "c1", name: "n" })).resolves.toBeUndefined();
    expect(codex.clearThreadGoal).not.toHaveBeenCalled();
    expect(codex.setThreadName).not.toHaveBeenCalled();
  });

  it("routes account-scoped reads to codex regardless of thread harness", async () => {
    const { codex, router } = createRouter();
    expect(router.readCodexVersion?.({ profile: "host" })).toBe("codex 1.0");
    await expect(router.readAccountRateLimits?.({ profile: "host" })).resolves.toEqual({ ok: true });
    expect(codex.readCodexVersion).toHaveBeenCalledTimes(1);
    expect(codex.readAccountRateLimits).toHaveBeenCalledTimes(1);
  });
});
