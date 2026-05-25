import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServer, ProfileCodexAppServerPool, buildCodexAppServerEnv } from "./appserver.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildCodexAppServerEnv", () => {
  it("uses a small allowlist and always sets profile-specific CODEX_HOME", () => {
    const env = buildCodexAppServerEnv("/tmp/twinny/profiles/guest/codex", {
      PATH: "/usr/bin",
      HOME: "/Users/example",
      LANG: "en_US.UTF-8",
      TWINNY_LARK_APP_SECRET: "secret",
      OPENAI_API_KEY: "also-secret"
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      LANG: "en_US.UTF-8",
      CODEX_HOME: "/tmp/twinny/profiles/guest/codex",
      NO_COLOR: "1"
    });
    expect(env.TWINNY_LARK_APP_SECRET).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("CodexAppServer", () => {
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
        TWINNY_LARK_APP_SECRET: "must-not-leak"
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
        hasLarkSecret: false
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
      await expect(server.runGoal({ threadId: "thread-existing", objective: "finish goal" })).resolves.toMatchObject({
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
          dynamicTools: [
            expect.objectContaining({
              namespace: "twinny",
              name: "set_thread_name",
              description: expect.stringContaining("15 Chinese characters or 10 words"),
              inputSchema: expect.not.objectContaining({
                maxLength: 15
              })
            })
          ]
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
      expect(sent.find((message) => message.method === "turn/start")).toMatchObject({
        params: {
          threadId: "thread-existing",
          input: [{ type: "text", text: "hello from lark", text_elements: [] }],
          cwd: workspace,
          approvalPolicy: "never"
        }
      });
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

function createFakeCodexBinary(tempDir: string, captureFile: string): string {
  const binary = path.join(tempDir, "fake-codex.mjs");
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

function onceExit(server: CodexAppServer): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    server.once("exit", (code, signal) => resolve({ code, signal }));
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
