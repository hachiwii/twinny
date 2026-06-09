import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeHarness, codexTurnInputToText } from "./claude.js";

class FakeClaudeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly writtenLines: string[] = [];
  stdinEnded = false;
  killed = false;
  exitCode: number | null = null;
  readonly killSignals: string[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) {
          this.writtenLines.push(line);
        }
      }
    });
    this.stdin.on("finish", () => {
      this.stdinEnded = true;
    });
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignals.push(signal ?? "SIGTERM");
    return true;
  }

  emitLine(payload: unknown): void {
    this.stdout.write(JSON.stringify(payload) + "\n");
  }

  exit(code: number | null, signal: string | null = null): void {
    this.exitCode = code;
    this.emit("close", code, signal);
  }
}

function createHarness(): {
  harness: ClaudeCodeHarness;
  processes: FakeClaudeProcess[];
  spawnCalls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }>;
} {
  const processes: FakeClaudeProcess[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  const spawnFn = vi.fn((command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
    const child = new FakeClaudeProcess();
    processes.push(child);
    return child;
  });
  const harness = new ClaudeCodeHarness({
    binary: "claude",
    claudeConfigDirFor: (profile) => (profile === "guest" ? "/tmp/claude-guest" : undefined),
    spawnFn: spawnFn as never
  });
  return { harness, processes, spawnCalls };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("codexTurnInputToText", () => {
  it("joins text items and references local images by path", () => {
    expect(
      codexTurnInputToText([
        { type: "text", text: "看看这张图", text_elements: [] },
        { type: "localImage", path: "/tmp/a.png", detail: null }
      ])
    ).toBe("看看这张图\n[本地图片，请用文件工具读取] /tmp/a.png");
    expect(codexTurnInputToText("plain")).toBe("plain");
  });
});

describe("ClaudeCodeHarness", () => {
  it("runs a turn end to end with commentary, final answer, and token usage", async () => {
    const { harness, processes, spawnCalls } = createHarness();
    const { threadId } = await harness.startThread({ profile: "guest", cwd: "/tmp/ws", approvalPolicy: "never" });

    const turnStarted = vi.fn();
    const agentMessages: Array<{ id: string; text: string; phase?: string | null }> = [];
    const tokenUsage = vi.fn();
    const resultPromise = harness.startTurn({
      profile: "guest",
      threadId,
      input: "你好",
      cwd: "/tmp/ws",
      approvalPolicy: "never",
      model: "sonnet",
      effort: "high",
      onTurnStarted: turnStarted,
      onAgentMessage: (message) => {
        agentMessages.push(message);
      },
      onTokenUsage: tokenUsage
    });

    await waitFor(() => processes.length === 1);
    const child = processes[0]!;
    const call = spawnCalls[0]!;
    expect(call.command).toBe("claude");
    expect(call.args).toContain("--session-id");
    expect(call.args).toContain(threadId);
    expect(call.args).toContain("--dangerously-skip-permissions");
    expect(call.args).toEqual(expect.arrayContaining(["--model", "sonnet"]));
    expect(call.args).toEqual(expect.arrayContaining(["--settings", JSON.stringify({ effort: "high" })]));
    expect(call.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-guest");
    expect(call.cwd).toBe("/tmp/ws");

    await waitFor(() => child.writtenLines.length === 1);
    expect(JSON.parse(child.writtenLines[0]!)).toMatchObject({
      type: "user",
      message: { role: "user" }
    });

    child.emitLine({ type: "system", subtype: "init", session_id: threadId, model: "claude-sonnet-4-6" });
    await waitFor(() => turnStarted.mock.calls.length === 1);
    const turnId = turnStarted.mock.calls[0]![0] as string;

    child.emitLine({
      type: "assistant",
      message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "先调查一下" }] },
      session_id: threadId
    });
    child.emitLine({
      type: "assistant",
      message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "答案是 42" }] },
      session_id: threadId
    });
    child.emitLine({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "答案是 42",
      session_id: threadId,
      usage: { input_tokens: 9, cache_read_input_tokens: 1, output_tokens: 5 }
    });
    await waitFor(() => child.stdinEnded);
    child.exit(0);

    const result = await resultPromise;
    expect(result).toMatchObject({ threadId, turnId, text: "答案是 42", status: "completed" });
    expect(agentMessages).toEqual([
      { id: "msg_1", text: "先调查一下", phase: "commentary" },
      { id: `claude:${turnId}:final`, text: "答案是 42", phase: "final_answer" }
    ]);
    expect(tokenUsage).toHaveBeenCalledTimes(1);
    expect(tokenUsage.mock.calls[0]![0]).toMatchObject({ threadId, totalTokens: 15 });
  });

  it("steers by writing additional user messages and waits for the extra result", async () => {
    const { harness, processes } = createHarness();
    const { threadId } = await harness.startThread({ profile: "host", cwd: "/tmp/ws", approvalPolicy: "never" });

    const agentMessages: Array<{ text: string; phase?: string | null }> = [];
    let turnId = "";
    const resultPromise = harness.startTurn({
      profile: "host",
      threadId,
      input: "第一个问题",
      cwd: "/tmp/ws",
      approvalPolicy: "never",
      onTurnStarted: (id) => {
        turnId = id;
      },
      onAgentMessage: (message) => {
        agentMessages.push({ text: message.text, phase: message.phase });
      }
    });

    await waitFor(() => processes.length === 1);
    const child = processes[0]!;
    child.emitLine({ type: "system", subtype: "init", session_id: threadId });
    await waitFor(() => turnId !== "");

    await harness.steerTurn({
      profile: "host",
      threadId,
      turnId,
      input: "补充说明",
      cwd: "/tmp/ws",
      approvalPolicy: "never"
    });
    await waitFor(() => child.writtenLines.length === 2);

    child.emitLine({ type: "result", subtype: "success", is_error: false, result: "第一个回答", session_id: threadId });
    child.emitLine({ type: "result", subtype: "success", is_error: false, result: "第二个回答", session_id: threadId });
    await waitFor(() => child.stdinEnded);
    child.exit(0);

    const result = await resultPromise;
    expect(result.status).toBe("completed");
    expect(result.text).toBe("第一个回答\n\n第二个回答");
    expect(agentMessages).toEqual([
      { text: "第一个回答", phase: "commentary" },
      { text: "第二个回答", phase: "final_answer" }
    ]);
  });

  it("resolves interrupted turns when the process is killed", async () => {
    const { harness, processes } = createHarness();
    const { threadId } = await harness.startThread({ profile: "host", cwd: "/tmp/ws", approvalPolicy: "never" });

    let turnId = "";
    const resultPromise = harness.startTurn({
      profile: "host",
      threadId,
      input: "长任务",
      cwd: "/tmp/ws",
      approvalPolicy: "never",
      onTurnStarted: (id) => {
        turnId = id;
      }
    });
    await waitFor(() => processes.length === 1);
    const child = processes[0]!;
    child.emitLine({ type: "system", subtype: "init", session_id: threadId });
    await waitFor(() => turnId !== "");

    await harness.interruptTurn({ profile: "host", threadId, turnId });
    expect(child.killSignals).toContain("SIGINT");
    child.exit(null, "SIGINT");

    const result = await resultPromise;
    expect(result.status).toBe("interrupted");
  });

  it("retries with --session-id when resume reports a missing session", async () => {
    const { harness, processes, spawnCalls } = createHarness();
    // Unknown thread id (e.g. recovered after a restart) is assumed resumable.
    const threadId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    const resultPromise = harness.startTurn({
      profile: "host",
      threadId,
      input: "继续",
      cwd: "/tmp/ws",
      approvalPolicy: "never"
    });

    await waitFor(() => processes.length === 1);
    expect(spawnCalls[0]!.args).toEqual(expect.arrayContaining(["--resume", threadId]));
    processes[0]!.stderr.write("No conversation found with session ID aaaaaaaa\n");
    processes[0]!.exit(1);

    await waitFor(() => processes.length === 2);
    expect(spawnCalls[1]!.args).toEqual(expect.arrayContaining(["--session-id", threadId]));
    const retry = processes[1]!;
    retry.emitLine({ type: "system", subtype: "init", session_id: threadId });
    retry.emitLine({ type: "result", subtype: "success", is_error: false, result: "重建成功", session_id: threadId });
    await waitFor(() => retry.stdinEnded);
    retry.exit(0);

    const result = await resultPromise;
    expect(result).toMatchObject({ status: "completed", text: "重建成功" });
  });

  it("forks lazily with --fork-session and injects side boundary preambles", async () => {
    const { harness, processes, spawnCalls } = createHarness();
    const { threadId: sourceId } = await harness.startThread({ profile: "host", cwd: "/tmp/ws", approvalPolicy: "never" });
    const fork = await harness.forkThread({
      profile: "host",
      threadId: sourceId,
      cwd: "/tmp/ws",
      approvalPolicy: "never",
      ephemeral: true
    });
    expect(fork.threadId).not.toBe(sourceId);

    await harness.injectThreadItems({
      profile: "host",
      threadId: fork.threadId,
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "以下是 side 会话边界说明" }]
        }
      ]
    });

    const resultPromise = harness.startTurn({
      profile: "host",
      threadId: fork.threadId,
      input: "side 问题",
      cwd: "/tmp/ws",
      approvalPolicy: "never"
    });
    await waitFor(() => processes.length === 1);
    const call = spawnCalls[0]!;
    expect(call.args).toEqual(
      expect.arrayContaining(["--resume", sourceId, "--fork-session", "--session-id", fork.threadId])
    );
    const child = processes[0]!;
    await waitFor(() => child.writtenLines.length === 1);
    const payload = JSON.parse(child.writtenLines[0]!) as { message: { content: Array<{ text: string }> } };
    expect(payload.message.content[0]!.text).toContain("<context>");
    expect(payload.message.content[0]!.text).toContain("以下是 side 会话边界说明");
    expect(payload.message.content[0]!.text).toContain("side 问题");

    child.emitLine({ type: "system", subtype: "init", session_id: fork.threadId });
    child.emitLine({ type: "result", subtype: "success", is_error: false, result: "side 回答", session_id: fork.threadId });
    await waitFor(() => child.stdinEnded);
    child.exit(0);
    await expect(resultPromise).resolves.toMatchObject({ status: "completed", text: "side 回答" });

    // The second side turn resumes the fork directly.
    const second = harness.startTurn({
      profile: "host",
      threadId: fork.threadId,
      input: "追问",
      cwd: "/tmp/ws",
      approvalPolicy: "never"
    });
    await waitFor(() => processes.length === 2);
    expect(spawnCalls[1]!.args).toEqual(expect.arrayContaining(["--resume", fork.threadId]));
    const next = processes[1]!;
    next.emitLine({ type: "system", subtype: "init", session_id: fork.threadId });
    next.emitLine({ type: "result", subtype: "success", is_error: false, result: "追问回答", session_id: fork.threadId });
    await waitFor(() => next.stdinEnded);
    next.exit(0);
    await expect(second).resolves.toMatchObject({ status: "completed", text: "追问回答" });
  });

  it("uses plan permission mode for plan turns", async () => {
    const { harness, processes, spawnCalls } = createHarness();
    const { threadId } = await harness.startThread({ profile: "host", cwd: "/tmp/ws", approvalPolicy: "never" });
    const resultPromise = harness.startTurn({
      profile: "host",
      threadId,
      input: "做个计划",
      cwd: "/tmp/ws",
      approvalPolicy: "never",
      mode: "plan"
    });
    await waitFor(() => processes.length === 1);
    expect(spawnCalls[0]!.args).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
    expect(spawnCalls[0]!.args).not.toContain("--dangerously-skip-permissions");
    const child = processes[0]!;
    child.emitLine({ type: "system", subtype: "init", session_id: threadId });
    child.emitLine({ type: "result", subtype: "success", is_error: false, result: "计划如下", session_id: threadId });
    await waitFor(() => child.stdinEnded);
    child.exit(0);
    await expect(resultPromise).resolves.toMatchObject({ status: "completed" });
  });

  it("fails the turn when the process exits without a result", async () => {
    const { harness, processes } = createHarness();
    const { threadId } = await harness.startThread({ profile: "host", cwd: "/tmp/ws", approvalPolicy: "never" });
    const resultPromise = harness.startTurn({
      profile: "host",
      threadId,
      input: "你好",
      cwd: "/tmp/ws",
      approvalPolicy: "never"
    });
    await waitFor(() => processes.length === 1);
    const child = processes[0]!;
    child.emitLine({ type: "system", subtype: "init", session_id: threadId });
    child.stderr.write("boom\n");
    child.exit(1);
    await expect(resultPromise).rejects.toThrow(/exited before producing a result/);
  });
});
