import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimePaths, createTwinnyConfig } from "../config/index.js";
import { createConversationRepository, openRuntimeDatabase } from "../store/index.js";
import type { TwinnyConfig } from "../types.js";
import { formatStartupInitializationProbeDetail, runStartupInitializationProbe } from "./startup-probe.js";

describe("startup initialization probe", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("opens the runtime DB and restores unfinished message state without external side effects", async () => {
    const { config, paths } = createTestConfig();
    const db = openRuntimeDatabase(paths);
    const repository = createConversationRepository(db, { now: () => 1_234 });
    repository.create({
      conversationKey: "p2p_ou_guest",
      type: "p2p",
      chatId: "ou_guest",
      name: "Guest User",
      role: "guest",
      codexThreadId: "thread_recovered",
      workspace: path.join(paths.workspacesDir, "p2p_ou_guest"),
      roleCodexHome: config.roles.guest.codexHome
    });
    repository.insertLarkMessage({
      larkMessageId: "m1",
      eventId: "e_m1",
      larkUserId: "ou_guest",
      conversationKey: "p2p_ou_guest",
      codexThreadId: "thread_recovered",
      routeKind: "queued_message",
      status: "queued",
      text: "queued from command",
      larkCreateTime: 1_234,
      rawEventJson: JSON.stringify(rawReceiveEvent("m1", "/queue queued from command"))
    });
    db.close();

    const result = await runStartupInitializationProbe({
      config,
      paths,
      logger: createLogger()
    });

    expect(result.recovery).toMatchObject({
      unfinishedMessages: 1,
      queuedMessages: 1,
      processingMessages: 0,
      recoveredMessages: 1,
      failedMessages: 0,
      stateCount: 1,
      pendingMessages: 1,
      roles: { owner: 0, guest: 1 }
    });
    expect(formatStartupInitializationProbeDetail(result)).toContain("unfinished=1");

    const verifyDb = openRuntimeDatabase(paths);
    try {
      const stored = createConversationRepository(verifyDb).getLarkMessageById("m1");
      expect(stored?.status).toBe("queued");
      expect(stored?.processingStartedAt).toBeUndefined();
    } finally {
      verifyDb.close();
    }
  });

  it("reports malformed unfinished messages without writing terminal state", async () => {
    const { config, paths } = createTestConfig();
    const db = openRuntimeDatabase(paths);
    const repository = createConversationRepository(db, { now: () => 1_234 });
    repository.insertLarkMessage({
      larkMessageId: "m_bad",
      eventId: "e_bad",
      larkUserId: "ou_guest",
      conversationKey: "group_oc_group",
      routeKind: "queued_message",
      status: "queued",
      text: "bad",
      rawEventJson: "{}"
    });
    db.close();

    const result = await runStartupInitializationProbe({
      config,
      paths,
      logger: createLogger()
    });

    expect(result.recovery).toMatchObject({
      unfinishedMessages: 1,
      recoveredMessages: 0,
      failedMessages: 1,
      stateCount: 1
    });
    expect(result.recovery.failures[0]).toMatchObject({
      eventId: "e_bad",
      larkMessageId: "m_bad",
      status: "queued"
    });

    const verifyDb = openRuntimeDatabase(paths);
    try {
      expect(createConversationRepository(verifyDb).getLarkMessageById("m_bad")?.status).toBe("queued");
    } finally {
      verifyDb.close();
    }
  });

  function createTestConfig(): { config: TwinnyConfig; paths: ReturnType<typeof createRuntimePaths> } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-startup-probe-"));
    tempDirs.push(home);
    const config = createTwinnyConfig({
      home,
      lark: { appId: "cli_app" },
      owner: { openId: "ou_owner", displayName: "Owner User" }
    });
    return {
      config,
      paths: createRuntimePaths(home)
    };
  }
});

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Logger;
}

function rawReceiveEvent(messageId: string, text: string) {
  return {
    event_id: `e_${messageId}`,
    sender: {
      sender_id: {
        open_id: "ou_guest"
      },
      sender_type: "user"
    },
    message: {
      message_id: messageId,
      create_time: "1234",
      chat_id: "oc_ignored",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text })
    }
  };
}
