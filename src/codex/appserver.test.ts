import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServer, buildCodexAppServerEnv } from "./appserver.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildCodexAppServerEnv", () => {
  it("uses a small allowlist and always sets role-specific CODEX_HOME", () => {
    const env = buildCodexAppServerEnv("/tmp/twinny/roles/guest/codex", {
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
      CODEX_HOME: "/tmp/twinny/roles/guest/codex",
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
    const workspace = path.join(tempDir, "workspaces", "p2p:ou_1");
    fs.mkdirSync(workspace, { recursive: true });

    const server = new CodexAppServer({
      role: "guest",
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

    try {
      const initialized = await server.start();
      expect(initialized).toMatchObject({
        userAgent: "fake-codex",
        codexHome: path.resolve(codexHome),
        platformFamily: "unix",
        platformOs: "macos",
        hasLarkSecret: false
      });

      await expect(server.startThread(workspace)).resolves.toMatchObject({
        thread: { id: "thread-start" }
      });
      const guestCodexConfig = parse(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")) as TomlTable;
      expect((guestCodexConfig.projects as TomlTable)[workspace]).toEqual({ trust_level: "trusted" });
      await expect(server.resumeThread("thread-existing", workspace)).resolves.toMatchObject({
        thread: { id: "thread-existing" }
      });
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
          persistExtendedHistory: true
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
      expect(sent.find((message) => message.method === "turn/start")).toMatchObject({
        params: {
          threadId: "thread-existing",
          input: [{ type: "text", text: "hello from lark", text_elements: [] }],
          cwd: workspace,
          approvalPolicy: "never"
        }
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
        platformOs: "macos",
        hasLarkSecret: Boolean(process.env.TWINNY_LARK_APP_SECRET)
      }
    });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-start" } } });
    return;
  }
  if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
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

function readCapturedMessages(captureFile: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(captureFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
