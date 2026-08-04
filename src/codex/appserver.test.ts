import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServer,
  ProfileCodexAppServerPool,
  buildCodexAppServerSpawnOptions,
  buildCodexAppServerEnv,
  createCodexAppServerProcessTreeTarget,
  parseCodexCliVersionOutput,
  resolveCodexTuiClientInfoVersion,
  terminateCodexAppServerProcessTree
} from "./appserver.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildCodexAppServerEnv", () => {
  it("inherits daemon environment and always sets profile-specific CODEX_HOME", () => {
    const env = buildCodexAppServerEnv("/tmp/twinny/profiles/guest/codex", {
      PATH: "/usr/bin",
      HOME: "/Users/example",
      LANG: "en_US.UTF-8",
      TWINNY_LARK_APP_SECRET: "secret",
      OPENAI_API_KEY: "also-secret",
      CODEX_HOME: "/tmp/source-codex-home",
      NO_COLOR: "0"
    });

    expect(env).toMatchObject({
      PATH: [path.dirname(process.execPath), "/usr/bin"].join(path.delimiter),
      HOME: "/Users/example",
      LANG: "en_US.UTF-8",
      TWINNY_LARK_APP_SECRET: "secret",
      OPENAI_API_KEY: "also-secret",
      CODEX_HOME: "/tmp/twinny/profiles/guest/codex",
      NO_COLOR: "0"
    });
  });

  it("keeps the current Node executable available for npm-style Codex shims", () => {
    const env = buildCodexAppServerEnv("/tmp/twinny/profiles/guest/codex", {});

    const pathEntries = env.PATH?.split(path.delimiter) ?? [];
    expect(pathEntries[0]).toBe(path.dirname(process.execPath));
    expect(pathEntries).toContain("/usr/bin");
  });
});

describe("Codex app-server process tree", () => {
  it("spawns POSIX app-servers in an isolated process group without applying POSIX semantics on Windows", () => {
    const base = { cwd: "/tmp/twinny", env: { PATH: "/usr/bin" } };

    expect(buildCodexAppServerSpawnOptions(base, "darwin")).toMatchObject({
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    expect(buildCodexAppServerSpawnOptions(base, "linux")).toMatchObject({ detached: true });
    expect(buildCodexAppServerSpawnOptions(base, "win32")).toMatchObject({ detached: false });
  });

  it("signals a POSIX process group by negative PGID and deduplicates repeated cleanup", async () => {
    const killProcess = vi.fn((): true => true);
    const killChild = vi.fn(() => true);
    const target = createCodexAppServerProcessTreeTarget({ pid: 43210, kill: killChild }, "darwin", true);

    await expect(terminateCodexAppServerProcessTree(target, "SIGTERM", { killProcess })).resolves.toBe(true);
    await expect(terminateCodexAppServerProcessTree(target, "SIGTERM", { killProcess })).resolves.toBe(true);

    expect(killProcess).toHaveBeenCalledOnce();
    expect(killProcess).toHaveBeenCalledWith(-43210, "SIGTERM");
    expect(killChild).not.toHaveBeenCalled();
  });

  it("treats missing POSIX process groups as an idempotent successful cleanup", async () => {
    const missing = Object.assign(new Error("missing process group"), { code: "ESRCH" });
    const killProcess = vi.fn((): true => {
      throw missing;
    });
    const target = createCodexAppServerProcessTreeTarget({ pid: 43211, kill: vi.fn() }, "linux", true);

    await expect(terminateCodexAppServerProcessTree(target, "SIGKILL", { killProcess })).resolves.toBe(true);
  });

  it("rejects EPERM when the isolated POSIX process group was never reached", async () => {
    const permissionDenied = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const killProcess = vi.fn((): true => {
      throw permissionDenied;
    });
    const target = createCodexAppServerProcessTreeTarget({ pid: 43215, kill: vi.fn() }, "darwin", true);

    await expect(terminateCodexAppServerProcessTree(target, "SIGKILL", { killProcess })).rejects.toBe(permissionDenied);
  });

  it("accepts Darwin's partial-success EPERM when escalating a previously reached group", async () => {
    const permissionDenied = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const killProcess = vi.fn((_pid: number, signal: NodeJS.Signals): true => {
      if (signal === "SIGKILL") {
        throw permissionDenied;
      }
      return true;
    });
    const target = createCodexAppServerProcessTreeTarget({ pid: 43216, kill: vi.fn() }, "darwin", true);

    await expect(terminateCodexAppServerProcessTree(target, "SIGTERM", { killProcess })).resolves.toBe(true);
    await expect(terminateCodexAppServerProcessTree(target, "SIGKILL", { killProcess })).resolves.toBe(true);

    expect(killProcess).toHaveBeenNthCalledWith(1, -43216, "SIGTERM");
    expect(killProcess).toHaveBeenNthCalledWith(2, -43216, "SIGKILL");
  });

  it("does not apply Darwin's process-group EPERM semantics on Linux", async () => {
    const permissionDenied = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const killProcess = vi.fn((_pid: number, signal: NodeJS.Signals): true => {
      if (signal === "SIGKILL") {
        throw permissionDenied;
      }
      return true;
    });
    const target = createCodexAppServerProcessTreeTarget({ pid: 43217, kill: vi.fn() }, "linux", true);

    await expect(terminateCodexAppServerProcessTree(target, "SIGTERM", { killProcess })).resolves.toBe(true);
    await expect(terminateCodexAppServerProcessTree(target, "SIGKILL", { killProcess })).rejects.toBe(permissionDenied);
  });

  it("does not let stale cleanup kill a new process tree that reused the old PID", async () => {
    const killProcess = vi.fn((): true => true);
    const oldTarget = createCodexAppServerProcessTreeTarget({ pid: 43212, kill: vi.fn() }, "darwin", true);
    const currentTarget = createCodexAppServerProcessTreeTarget({ pid: 43212, kill: vi.fn() }, "darwin", true);

    await expect(
      terminateCodexAppServerProcessTree(oldTarget, "SIGKILL", { killProcess, currentTarget })
    ).resolves.toBe(false);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("refuses to target Twinny's own PID as a process group", async () => {
    const killProcess = vi.fn((): true => true);
    const killChild = vi.fn(() => true);
    const target = createCodexAppServerProcessTreeTarget({ pid: process.pid, kill: killChild }, "darwin", true);

    await expect(terminateCodexAppServerProcessTree(target, "SIGKILL", { killProcess })).resolves.toBe(false);
    expect(killProcess).not.toHaveBeenCalled();
    expect(killChild).not.toHaveBeenCalled();
  });

  it("uses the Windows tree terminator and falls back to the direct child on taskkill failure", async () => {
    const killChild = vi.fn(() => true);
    const treeKill = vi.fn(async () => undefined);
    const target = createCodexAppServerProcessTreeTarget({ pid: 43213, kill: killChild }, "win32", false);

    await expect(
      terminateCodexAppServerProcessTree(target, "SIGTERM", { killWindowsTree: treeKill })
    ).resolves.toBe(true);
    expect(treeKill).toHaveBeenCalledWith(43213, "SIGTERM");
    expect(killChild).not.toHaveBeenCalled();

    const fallbackTarget = createCodexAppServerProcessTreeTarget({ pid: 43214, kill: killChild }, "win32", false);
    await expect(
      terminateCodexAppServerProcessTree(fallbackTarget, "SIGKILL", {
        killWindowsTree: vi.fn(async () => {
          throw new Error("taskkill unavailable");
        })
      })
    ).resolves.toBe(true);
    expect(killChild).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("CodexAppServer", () => {
  it("parses Codex CLI version output for initialize masquerading", () => {
    expect(parseCodexCliVersionOutput("codex 0.130.0")).toBe("0.130.0");
    expect(parseCodexCliVersionOutput("codex-cli 0.131.2+build.4")).toBe("0.131.2+build.4");
    expect(parseCodexCliVersionOutput("unknown")).toBeUndefined();
    expect(resolveCodexTuiClientInfoVersion("codex-cli 0.135.0")).toBe("0.135.0");
    expect(resolveCodexTuiClientInfoVersion("不可用")).toBe("");
  });

  it("handshakes with a fake stdio app-server and emits Twinny's constrained requests", async () => {
    const tempDir = makeTempDir();
    const captureFile = path.join(tempDir, "requests.ndjson");
    const fakeBinary = createFakeCodexBinary(tempDir, captureFile);
    const codexHome = path.join(tempDir, "codex-home");
    const workspace = path.join(tempDir, "workspaces", "p2p_ou_1");
    fs.mkdirSync(workspace, { recursive: true });

    const server = new CodexAppServer({
      profile: "guest",
      binary: fakeBinary,
      codexHome,
      requestTimeoutMs: 2_000,
      clientVersion: "test",
      env: {
        PATH: process.env.PATH,
        HOME: tempDir,
        TWINNY_LARK_APP_SECRET: "inherited-secret"
      }
    });
    const threadNameUpdated = onceThreadNameUpdated(server);

    try {
      const initialized = await server.start();
      expect(initialized).toMatchObject({
        userAgent: "fake-codex",
        codexHome: path.resolve(codexHome),
        platformFamily: "unix",
        platformOs: "macos",
        hasLarkSecret: true
      });
      expect(server.readCodexVersion()).toBe("fake-codex 1.2.3");

      await expect(server.startThread(workspace, { developerInstructions: "main instructions" })).resolves.toMatchObject({
        thread: { id: "thread-start" }
      });
      await expect(threadNameUpdated).resolves.toEqual({
        threadId: "thread-start",
        name: "Started thread title"
      });
      const guestCodexConfig = parse(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")) as TomlTable;
      expect((guestCodexConfig.projects as TomlTable)[workspace]).toEqual({ trust_level: "trusted" });
      expect(guestCodexConfig.default_permissions).toBeUndefined();
      expect(guestCodexConfig.permissions).toBeUndefined();
      await expect(server.resumeThread("thread-existing", workspace)).resolves.toMatchObject({
        thread: { id: "thread-existing" }
      });
      await expect(server.forkThread("thread-existing", workspace)).resolves.toMatchObject({
        thread: { id: "thread-forked", forkedFromId: "thread-existing" }
      });
      await expect(
        server.forkThread("thread-existing", workspace, {
          ephemeral: true,
          developerInstructions: "side instructions",
          model: "gpt-5.5",
          effort: "medium"
        })
      ).resolves.toMatchObject({
        thread: { id: "thread-forked", forkedFromId: "thread-existing" }
      });
      await expect(server.injectThreadItems("thread-forked", [{ type: "message" }])).resolves.toBeUndefined();
      await expect(server.unsubscribeThread("thread-forked")).resolves.toBeUndefined();
      await expect(server.setThreadName("thread-existing", "排查标题更新")).resolves.toBeUndefined();
      await expect(
        server.startTurn({
          threadId: "thread-existing",
          text: "hello from lark",
          cwd: workspace
        })
      ).resolves.toMatchObject({
        threadId: "thread-existing",
        turnId: "turn-1",
        text: "item text\n\ncompleted text",
        status: "completed",
        durationMs: 7
      });
      await expect(server.compactThread({ threadId: "thread-existing", cwd: workspace })).resolves.toMatchObject({
        threadId: "thread-existing",
        turnId: "turn-compact",
        status: "completed",
        durationMs: 3
      });
      await expect(server.runGoal({ threadId: "thread-existing", cwd: workspace, objective: "finish goal" })).resolves.toMatchObject({
        threadId: "thread-existing",
        turnId: "goal-turn-1",
        text: "goal completed",
        status: "completed"
      });
      await expect(server.getThreadGoal("thread-existing")).resolves.toMatchObject({
        threadId: "thread-existing",
        objective: "finish goal",
        status: "complete"
      });
      await expect(server.resumeGoal({ threadId: "thread-existing", cwd: workspace })).resolves.toMatchObject({
        threadId: "thread-existing",
        status: "completed"
      });
      await expect(server.clearThreadGoal("thread-existing")).resolves.toBeUndefined();
      await expect(
        server.steerTurn({
          threadId: "thread-existing",
          turnId: "turn-1",
          text: "steer from lark"
        })
      ).resolves.toBeUndefined();
      await expect(server.interruptTurn({ threadId: "thread-existing", turnId: "turn-1" })).resolves.toBeUndefined();

      const sent = readCapturedMessages(captureFile);
      expect(sent[0]).toMatchObject({
        method: "initialize",
        params: {
          clientInfo: { name: "twinny", title: "Twinny", version: "test" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: null }
        }
      });
      expect(sent[1]).toEqual({ method: "initialized" });
      expect(sent.find((message) => message.method === "thread/start")).toMatchObject({
        params: {
          cwd: workspace,
          approvalPolicy: "never",
          persistExtendedHistory: true,
          developerInstructions: "main instructions",
          dynamicTools: expect.arrayContaining([
            expect.objectContaining({
              namespace: "twinny",
              name: "set_thread_name",
              description: expect.stringContaining("15 Chinese characters or 10 words"),
              inputSchema: expect.not.objectContaining({
                maxLength: 15
              })
            }),
            expect.objectContaining({ namespace: "twinny", name: "list_threads" }),
            expect.objectContaining({ namespace: "twinny", name: "new_thread" }),
            expect.objectContaining({ namespace: "twinny", name: "wait_for_threads" }),
            expect.objectContaining({ namespace: "twinny", name: "send_thread_ref" }),
            expect.objectContaining({ namespace: "twinny", name: "tell_thread" }),
            expect.objectContaining({ namespace: "twinny", name: "add_cron" }),
            expect.objectContaining({ namespace: "twinny", name: "list_cron" }),
            expect.objectContaining({ namespace: "twinny", name: "del_cron" }),
            expect.objectContaining({ namespace: "twinny", name: "watch_lark_url" }),
            expect.objectContaining({ namespace: "twinny", name: "list_lark_url_watchers" }),
            expect.objectContaining({ namespace: "twinny", name: "rm_lark_url_watchers" }),
            expect.objectContaining({ namespace: "twinny", name: "create_conversation" })
          ])
        }
      });
      expect(sent.find((message) => message.method === "thread/resume")).toMatchObject({
        params: {
          threadId: "thread-existing",
          cwd: workspace,
          approvalPolicy: "never",
          persistExtendedHistory: true
        }
      });
      expect(sent.find((message) => message.method === "thread/fork")).toMatchObject({
        params: {
          threadId: "thread-existing",
          cwd: workspace,
          approvalPolicy: "never",
          persistExtendedHistory: true,
          excludeTurns: true
        }
      });
      expect(sent.filter((message) => message.method === "thread/fork")[1]).toMatchObject({
        params: {
          threadId: "thread-existing",
          cwd: workspace,
          approvalPolicy: "never",
          persistExtendedHistory: false,
          excludeTurns: true,
          ephemeral: true,
          developerInstructions: "side instructions",
          model: "gpt-5.5",
          config: { model_reasoning_effort: "medium" }
        }
      });
      expect(sent.find((message) => message.method === "thread/inject_items")).toMatchObject({
        params: { threadId: "thread-forked", items: [{ type: "message" }] }
      });
      expect(sent.find((message) => message.method === "thread/unsubscribe")).toMatchObject({
        params: { threadId: "thread-forked" }
      });
      expect(sent.find((message) => message.method === "thread/name/set")).toMatchObject({
        params: { threadId: "thread-existing", name: "排查标题更新" }
      });
      const guestTurnStart = sent.find((message) => message.method === "turn/start");
      expect(guestTurnStart).toMatchObject({
        params: {
          threadId: "thread-existing",
          input: [{ type: "text", text: "hello from lark", text_elements: [] }],
          cwd: workspace,
          approvalPolicy: "never"
        }
      });
      expect(guestTurnStart?.params).not.toHaveProperty("sandboxPolicy");
      expect(sent.find((message) => message.method === "thread/compact/start")).toMatchObject({
        params: {
          threadId: "thread-existing"
        }
      });
      const goalSet = sent.find((message) => message.method === "thread/goal/set");
      expect(goalSet).toMatchObject({
        params: {
          threadId: "thread-existing",
          objective: "finish goal",
          status: "active"
        }
      });
      expect(goalSet?.params).not.toHaveProperty("tokenBudget");
      expect(sent.find((message) => message.method === "thread/goal/get")).toMatchObject({
        params: { threadId: "thread-existing" }
      });
      expect(sent.find((message) => message.method === "thread/goal/clear")).toMatchObject({
        params: { threadId: "thread-existing" }
      });
      expect(sent.find((message) => message.method === "turn/steer")).toMatchObject({
        params: {
          threadId: "thread-existing",
          input: [{ type: "text", text: "steer from lark", text_elements: [] }],
          expectedTurnId: "turn-1"
        }
      });
      expect(sent.find((message) => message.method === "turn/interrupt")).toMatchObject({
        params: {
          threadId: "thread-existing",
          turnId: "turn-1"
        }
      });
    } finally {
      await server.stop();
    }
  });

  it("can masquerade initialize client info as Codex TUI", async () => {
    const tempDir = makeTempDir();
    const captureFile = path.join(tempDir, "requests.ndjson");
    const fakeBinary = createFakeCodexBinary(tempDir, captureFile);
    const codexHome = path.join(tempDir, "codex-home");

    const server = new CodexAppServer({
      profile: "guest",
      binary: fakeBinary,
      codexHome,
      requestTimeoutMs: 2_000,
      clientVersion: "twinny-test",
      masqueradeAsCodexCli: true,
      env: {
        PATH: process.env.PATH,
        HOME: tempDir
      }
    });

    try {
      await expect(server.start()).resolves.toMatchObject({ userAgent: "fake-codex" });

      const sent = readCapturedMessages(captureFile);
      expect(sent[0]).toMatchObject({
        method: "initialize",
        params: {
          clientInfo: { name: "codex-tui", title: null, version: "1.2.3" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: null }
        }
      });
    } finally {
      await server.stop();
    }
  });

  it("leaves masqueraded Codex TUI client version empty when the Codex version probe fails", async () => {
    const tempDir = makeTempDir();
    const captureFile = path.join(tempDir, "requests.ndjson");
    const fakeBinary = createFakeCodexBinary(tempDir, captureFile, {
      versionExitCode: 1,
      versionOutput: "不可用"
    });
    const codexHome = path.join(tempDir, "codex-home");
    const probeFailures: unknown[] = [];

    const server = new CodexAppServer({
      profile: "guest",
      binary: fakeBinary,
      codexHome,
      requestTimeoutMs: 2_000,
      clientVersion: "twinny-test",
      masqueradeAsCodexCli: true,
      env: {
        PATH: process.env.PATH,
        HOME: tempDir
      }
    });
    server.on("versionProbeFailed", (failure) => probeFailures.push(failure));

    try {
      await expect(server.start()).resolves.toMatchObject({ userAgent: "fake-codex" });

      const sent = readCapturedMessages(captureFile);
      expect(sent[0]).toMatchObject({
        method: "initialize",
        params: {
          clientInfo: { name: "codex-tui", title: null, version: "" }
        }
      });
      expect(server.readCodexVersion()).toBe("");
      expect(probeFailures).toEqual([
        expect.objectContaining({
          binary: fakeBinary,
          reason: "unparseable output",
          exitCode: 1
        })
      ]);
    } finally {
      await server.stop();
    }
  });

  it("overrides host turn/start sandbox policy to danger full access", async () => {
    const tempDir = makeTempDir();
    const captureFile = path.join(tempDir, "requests.ndjson");
    const fakeBinary = createFakeCodexBinary(tempDir, captureFile);
    const codexHome = path.join(tempDir, "host-codex-home");
    const workspace = path.join(tempDir, "workspaces", "p2p_ou_owner");
    fs.mkdirSync(workspace, { recursive: true });

    const server = new CodexAppServer({
      profile: "host",
      binary: fakeBinary,
      codexHome,
      requestTimeoutMs: 2_000,
      clientVersion: "test",
      env: {
        PATH: process.env.PATH,
        HOME: tempDir
      }
    });

    try {
      await expect(server.start()).resolves.toMatchObject({ userAgent: "fake-codex" });
      await expect(
        server.startTurn({
          threadId: "thread-existing",
          text: "host work",
          cwd: workspace
        })
      ).resolves.toMatchObject({
        threadId: "thread-existing",
        turnId: "turn-1",
        status: "completed"
      });

      const sent = readCapturedMessages(captureFile);
      expect(sent.find((message) => message.method === "turn/start")).toMatchObject({
        params: {
          threadId: "thread-existing",
          input: [{ type: "text", text: "host work", text_elements: [] }],
          cwd: workspace,
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" }
        }
      });
    } finally {
      await server.stop();
    }
  });

  it("starts again after the app-server process exits", async () => {
    const tempDir = makeTempDir();
    const captureFile = path.join(tempDir, "requests.ndjson");
    const fakeBinary = createOneShotExitCodexBinary(tempDir, captureFile);
    const codexHome = path.join(tempDir, "codex-home");
    const workspace = path.join(tempDir, "workspaces", "p2p_ou_1");
    fs.mkdirSync(workspace, { recursive: true });

    const server = new CodexAppServer({
      profile: "host",
      binary: fakeBinary,
      codexHome,
      requestTimeoutMs: 2_000,
      clientVersion: "test",
      env: {
        PATH: process.env.PATH,
        HOME: tempDir
      }
    });

    try {
      const exited = onceExit(server);
      await expect(server.start()).resolves.toMatchObject({ userAgent: "fake-codex" });
      await expect(exited).resolves.toMatchObject({ code: 42, signal: null });

      await expect(server.start()).resolves.toMatchObject({ userAgent: "fake-codex" });
      await expect(server.startThread(workspace)).resolves.toMatchObject({
        thread: { id: "thread-start" }
      });

      const sent = readCapturedMessages(captureFile);
      expect(sent.filter((message) => message.method === "initialize")).toHaveLength(2);
      expect(sent.find((message) => message.method === "thread/start")).toMatchObject({
        params: {
          cwd: workspace,
          approvalPolicy: "never",
          persistExtendedHistory: true
        }
      });
    } finally {
      await server.stop();
    }
  });

  it.skipIf(process.platform === "win32")("kills app-server descendants during a normal stop", async () => {
    const tempDir = makeTempDir();
    const processTree = createProcessTreeCodexBinary(tempDir, "running");
    const server = new CodexAppServer({
      profile: "guest",
      binary: processTree.binary,
      codexHome: path.join(tempDir, "codex-home"),
      requestTimeoutMs: 500,
      stopTimeoutMs: 200,
      clientVersion: "test",
      env: { PATH: process.env.PATH, HOME: tempDir }
    });

    let descendantPid = 0;
    try {
      await server.start();
      descendantPid = await readPidFile(processTree.descendantPidFile);
      expect(isProcessAlive(descendantPid)).toBe(true);

      const exited = onceExit(server);
      await server.stop();
      await expect(exited).resolves.toMatchObject({ signal: "SIGTERM" });
      await expectProcessToExit(descendantPid);
    } finally {
      await server.stop().catch(() => undefined);
      killPidBestEffort(descendantPid);
    }
  });

  it.skipIf(process.platform === "win32")("kills remaining descendants after an unexpected app-server exit", async () => {
    const tempDir = makeTempDir();
    const processTree = createProcessTreeCodexBinary(tempDir, "exit");
    const server = new CodexAppServer({
      profile: "guest",
      binary: processTree.binary,
      codexHome: path.join(tempDir, "codex-home"),
      requestTimeoutMs: 500,
      clientVersion: "test",
      env: { PATH: process.env.PATH, HOME: tempDir }
    });

    let descendantPid = 0;
    try {
      const exited = onceExit(server);
      await server.start();
      descendantPid = await readPidFile(processTree.descendantPidFile);
      await expect(exited).resolves.toMatchObject({ code: 42, signal: null });
      await expectProcessToExit(descendantPid);
    } finally {
      await server.stop().catch(() => undefined);
      killPidBestEffort(descendantPid);
    }
  });

  it.skipIf(process.platform === "win32")("kills the process tree as soon as the app-server becomes unhealthy", async () => {
    const tempDir = makeTempDir();
    const processTree = createProcessTreeCodexBinary(tempDir, "disconnect");
    const server = new CodexAppServer({
      profile: "guest",
      binary: processTree.binary,
      codexHome: path.join(tempDir, "codex-home"),
      requestTimeoutMs: 500,
      clientVersion: "test",
      env: { PATH: process.env.PATH, HOME: tempDir }
    });

    let descendantPid = 0;
    try {
      const unhealthy = onceUnhealthy(server);
      await server.start();
      descendantPid = await readPidFile(processTree.descendantPidFile);
      await expect(unhealthy).resolves.toMatchObject({ code: "CODEX_APP_SERVER_UNHEALTHY" });
      await expectProcessToExit(descendantPid);
    } finally {
      await server.stop().catch(() => undefined);
      killPidBestEffort(descendantPid);
    }
  });

  it.skipIf(process.platform === "win32")("cleans the process tree when app-server initialization fails", async () => {
    const tempDir = makeTempDir();
    const processTree = createProcessTreeCodexBinary(tempDir, "start-failure");
    const server = new CodexAppServer({
      profile: "guest",
      binary: processTree.binary,
      codexHome: path.join(tempDir, "codex-home"),
      requestTimeoutMs: 200,
      clientVersion: "test",
      env: { PATH: process.env.PATH, HOME: tempDir }
    });

    let descendantPid = 0;
    try {
      await expect(server.start()).rejects.toBeDefined();
      descendantPid = await readPidFile(processTree.descendantPidFile);
      await expectProcessToExit(descendantPid);
    } finally {
      await server.stop().catch(() => undefined);
      killPidBestEffort(descendantPid);
    }
  });

  it("marks a live app-server unhealthy when its stdout protocol stream closes", async () => {
    const tempDir = makeTempDir();
    const captureFile = path.join(tempDir, "requests.ndjson");
    const fakeBinary = createDisconnectedCodexBinary(tempDir, captureFile);
    const codexHome = path.join(tempDir, "codex-home");
    const server = new CodexAppServer({
      profile: "guest",
      binary: fakeBinary,
      codexHome,
      requestTimeoutMs: 2_000,
      clientVersion: "test",
      env: {
        PATH: process.env.PATH,
        HOME: tempDir
      }
    });
    const unhealthy = onceUnhealthy(server);

    try {
      await expect(server.start()).resolves.toMatchObject({ userAgent: "fake-codex" });
      await expect(unhealthy).resolves.toMatchObject({
        code: "CODEX_APP_SERVER_UNHEALTHY"
      });
      expect(server.initialized).toBeUndefined();
    } finally {
      await server.stop();
    }
  });
});

describe("ProfileCodexAppServerPool", () => {
  it("restarts the selected profile after its app-server exits", async () => {
    const tempDir = makeTempDir();
    const captureFile = path.join(tempDir, "requests.ndjson");
    const fakeBinary = createOneShotExitCodexBinary(tempDir, captureFile);
    const workspace = path.join(tempDir, "workspaces", "p2p_ou_1");
    fs.mkdirSync(workspace, { recursive: true });

    const pool = new ProfileCodexAppServerPool({
      binary: fakeBinary,
      profiles: {
        host: { codexHome: path.join(tempDir, "host-codex-home") },
        guest: { codexHome: path.join(tempDir, "guest-codex-home") }
      },
      requestTimeoutMs: 2_000,
      clientVersion: "test",
      env: {
        PATH: process.env.PATH,
        HOME: tempDir
      }
    });
    const host = pool.get("host");

    try {
      const exited = onceExit(host);
      await expect(host.start()).resolves.toMatchObject({ userAgent: "fake-codex" });
      await expect(exited).resolves.toMatchObject({ code: 42, signal: null });

      await expect(pool.restart("host")).resolves.toMatchObject({ userAgent: "fake-codex" });
      await expect(host.startThread(workspace)).resolves.toMatchObject({
        thread: { id: "thread-start" }
      });
      const hostConfig = parse(fs.readFileSync(path.join(tempDir, "host-codex-home", "config.toml"), "utf8")) as TomlTable;
      expect((hostConfig.projects as TomlTable)[workspace]).toEqual({ trust_level: "trusted" });
      expect(hostConfig.default_permissions).toBeUndefined();
      expect(hostConfig.permissions).toBeUndefined();
    } finally {
      await pool.stopAll();
    }
  });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-codex-test-"));
  tempDirs.push(dir);
  return dir;
}

function createFakeCodexBinary(
  tempDir: string,
  captureFile: string,
  options: { versionOutput?: string; versionExitCode?: number } = {}
): string {
  const binary = path.join(tempDir, "fake-codex.mjs");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const captureFile = ${JSON.stringify(captureFile)};
if (process.argv.includes("--version")) {
  process.stdout.write(${JSON.stringify(`${options.versionOutput ?? "fake-codex 1.2.3"}\n`)});
  process.exit(${JSON.stringify(options.versionExitCode ?? 0)});
}

const rl = readline.createInterface({ input: process.stdin });
const goals = new Map();

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  fs.appendFileSync(captureFile, line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fake-codex",
        codexHome: process.env.CODEX_HOME,
        platformFamily: "unix",
        platformOs: "macos",
        hasLarkSecret: Boolean(process.env.TWINNY_LARK_APP_SECRET)
      }
    });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-start" } } });
    send({ method: "thread/name/updated", params: { thread_id: "thread-start", thread_name: "Started thread title" } });
    return;
  }
  if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === "thread/goal/set") {
    const goal = {
      threadId: message.params.threadId,
      objective: message.params.objective ?? "goal",
      status: message.params.status ?? "active",
      tokenBudget: message.params.tokenBudget ?? null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1
    };
    goals.set(message.params.threadId, goal);
    send({ id: message.id, result: { goal } });
    send({
      method: "turn/started",
      params: { threadId: message.params.threadId, turn: { id: "goal-turn-1" } }
    });
    send({
      method: "item/completed",
      params: {
        threadId: message.params.threadId,
        turnId: "goal-turn-1",
        item: { type: "agentMessage", id: "goal-msg-1", text: "goal progress", phase: "commentary" },
        completedAtMs: Date.now()
      }
    });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turn: {
          id: "goal-turn-1",
          status: "completed",
          durationMs: 5,
          items: [{ type: "agentMessage", id: "goal-msg-2", text: "goal completed", phase: "final_answer" }]
        }
      }
    });
    const completedGoal = { ...goal, status: "complete", updatedAt: 2 };
    goals.set(message.params.threadId, completedGoal);
    send({
      method: "thread/goal/updated",
      params: { threadId: message.params.threadId, turnId: "goal-turn-1", goal: completedGoal }
    });
    return;
  }
  if (message.method === "thread/goal/get") {
    send({ id: message.id, result: { goal: goals.get(message.params.threadId) ?? null } });
    return;
  }
  if (message.method === "thread/goal/clear") {
    const cleared = goals.delete(message.params.threadId);
    send({ id: message.id, result: { cleared } });
    if (cleared) {
      send({ method: "thread/goal/cleared", params: { threadId: message.params.threadId } });
    }
    return;
  }
  if (message.method === "thread/fork") {
    send({ id: message.id, result: { thread: { id: "thread-forked", forkedFromId: message.params.threadId } } });
    return;
  }
  if (message.method === "thread/inject_items") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/unsubscribe") {
    send({ id: message.id, result: { status: "unsubscribed" } });
    return;
  }
  if (message.method === "thread/name/set") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({
      method: "turn/started",
      params: { threadId: message.params.threadId, turn: { id: "turn-1" } }
    });
    send({
      method: "item/completed",
      params: {
        threadId: message.params.threadId,
        turnId: "turn-1",
        item: { type: "agentMessage", id: "msg-1", text: "item text" },
        completedAtMs: Date.now()
      }
    });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turn: {
          id: "turn-1",
          status: "completed",
          durationMs: 7,
          items: [
            { type: "agentMessage", id: "msg-1", text: "item text" },
            { type: "agentMessage", id: "msg-2", text: "completed text" }
          ]
        }
      }
    });
    return;
  }
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/started",
      params: { threadId: message.params.threadId, turn: { id: "turn-compact" } }
    });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turn: {
          id: "turn-compact",
          status: "completed",
          durationMs: 3,
          items: []
        }
      }
    });
    return;
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }
});
`,
    { mode: 0o755 }
  );
  return binary;
}

function createOneShotExitCodexBinary(tempDir: string, captureFile: string): string {
  const binary = path.join(tempDir, "fake-codex-restart.mjs");
  const runFile = path.join(tempDir, "fake-codex-runs.txt");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const captureFile = ${JSON.stringify(captureFile)};
const runFile = ${JSON.stringify(runFile)};
if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.2.3\\n");
  process.exit(0);
}

const previousRuns = fs.existsSync(runFile) ? Number(fs.readFileSync(runFile, "utf8")) : 0;
const run = previousRuns + 1;
fs.writeFileSync(runFile, String(run));
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  fs.appendFileSync(captureFile, line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fake-codex",
        codexHome: process.env.CODEX_HOME,
        platformFamily: "unix",
        platformOs: "macos"
      }
    });
    if (run === 1) {
      setTimeout(() => process.exit(42), 5);
    }
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-start" } } });
  }
});
`,
    { mode: 0o755 }
  );
  return binary;
}

function createDisconnectedCodexBinary(tempDir: string, captureFile: string): string {
  const binary = path.join(tempDir, "fake-codex-disconnected.mjs");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const captureFile = ${JSON.stringify(captureFile)};
if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.2.3\\n");
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
const keepAlive = setInterval(() => undefined, 1_000);

rl.on("line", (line) => {
  fs.appendFileSync(captureFile, line + "\\n");
  const message = JSON.parse(line);
  if (message.method !== "initialize") {
    return;
  }
  process.stdout.write(JSON.stringify({
    id: message.id,
    result: {
      userAgent: "fake-codex",
      codexHome: process.env.CODEX_HOME,
      platformFamily: "unix",
      platformOs: "macos"
    }
  }) + "\\n", () => fs.closeSync(1));
});

rl.on("close", () => clearInterval(keepAlive));
`,
    { mode: 0o755 }
  );
  return binary;
}

function createProcessTreeCodexBinary(
  tempDir: string,
  mode: "running" | "exit" | "disconnect" | "start-failure"
): { binary: string; descendantPidFile: string } {
  const binary = path.join(tempDir, `fake-codex-process-tree-${mode}.mjs`);
  const descendantPidFile = path.join(tempDir, `descendant-${mode}.pid`);
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.2.3\\n");
  process.exit(0);
}

const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
  stdio: "ignore"
});
fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method !== "initialize") return;
  if (${JSON.stringify(mode)} === "start-failure") {
    process.stdout.end();
    return;
  }
  process.stdout.write(JSON.stringify({
    id: message.id,
    result: {
      userAgent: "fake-codex",
      codexHome: process.env.CODEX_HOME,
      platformFamily: "unix",
      platformOs: "macos"
    }
  }) + "\\n", () => {
    if (${JSON.stringify(mode)} === "disconnect") {
      process.stdout.end();
    } else if (${JSON.stringify(mode)} === "exit") {
      setTimeout(() => process.exit(42), 20);
    }
  });
});
`,
    { mode: 0o755 }
  );
  return { binary, descendantPidFile };
}

async function readPidFile(file: string, timeoutMs = 1_000): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(file)) {
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 1) {
        return pid;
      }
    }
    await waitForDelay(5);
  }
  throw new Error(`timed out waiting for pid file ${file}`);
}

async function expectProcessToExit(pid: number, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await waitForDelay(5);
  }
  expect(isProcessAlive(pid), `process ${pid} should have exited`).toBe(false);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function killPidBestEffort(pid: number): void {
  if (!isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort test cleanup only.
  }
}

function waitForDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceExit(server: CodexAppServer): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    server.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function onceUnhealthy(server: CodexAppServer): Promise<Error> {
  return new Promise((resolve) => {
    server.once("unhealthy", resolve);
  });
}

function onceThreadNameUpdated(server: CodexAppServer): Promise<unknown> {
  return new Promise((resolve) => {
    server.once("threadNameUpdated", (update) => resolve(update));
  });
}

function readCapturedMessages(captureFile: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(captureFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
