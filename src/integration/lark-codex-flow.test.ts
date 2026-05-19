import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RoleCodexAppServerPool } from "../codex/appserver.js";
import type { CodexRequestUserInputResponder, CodexTurnInput } from "../codex/turn.js";
import { createTwinnyConfig } from "../config/loader.js";
import {
  ConversationManager,
  type CodexBridge,
  type ConversationRepository as ManagerConversationRepository,
  type LarkResponder
} from "../conversation/manager.js";
import {
  LarkEventConsumer,
  type EventDispatcherLike,
  type WsClientLike
} from "../lark/events.js";
import { TenantAccessTokenManager } from "../lark/auth.js";
import { LarkChatDirectory, LarkUserDirectory } from "../lark/contact.js";
import { LarkFileDownloader } from "../lark/files.js";
import { LarkMessageReader, LarkMessageSender } from "../lark/messages.js";
import { LarkOpenApiClient } from "../lark/openapi.js";
import type { FetchLike, FetchResponseLike } from "../lark/types.js";
import {
  createConversationRepository,
  openTwinnyDatabase,
  type ConversationRepository as StoreConversationRepository,
  type TwinnyDatabase
} from "../store/index.js";
import type {
  CodexAgentMessage,
  CodexPlanUpdate,
  CodexRequestUserInputRequest,
  CodexThreadMode,
  CodexThreadTokenUsageUpdate,
  LarkReactionHandle,
  RoleName,
  TwinnyConfig
} from "../types.js";
import { WorkspaceManager } from "../workspace/manager.js";

const harnesses: IntegrationHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("Lark to Codex integration flow", () => {
  it("starts a P2P Codex turn, steers a later Lark message, and replies through Lark APIs in order", async () => {
    const harness = await IntegrationHarness.create(`
{"role":"guest","after":{"method":"turn/start","nth":1},"notify":{"method":"turn/started","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1"}}}}
{"role":"guest","after":{"method":"turn/start","nth":1},"notify":{"method":"item/completed","params":{"threadId":"guest_thread_1","turnId":"turn_1","item":{"type":"agentMessage","id":"agent_1","text":"working on first","phase":"commentary"}}}}
{"role":"guest","after":{"method":"turn/steer","nth":1},"notify":{"method":"item/completed","params":{"threadId":"guest_thread_1","turnId":"turn_1","item":{"type":"agentMessage","id":"agent_2","text":"final answer after steer","phase":"final_answer"}}}}
{"role":"guest","after":{"method":"turn/steer","nth":1},"notify":{"method":"turn/completed","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1","status":"completed","durationMs":10,"items":[{"type":"agentMessage","id":"agent_2","text":"final answer after steer","phase":"final_answer"}]}}}}
`);

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_m1", messageId: "m1", text: "first request" }))}}
`);
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "first turn/start");

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_m2", messageId: "m2", text: "second request" }))}}
`);
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("final answer after steer")),
      "final card patch"
    );

    const trace = harness.readTrace();
    expect(codexOut(trace, "thread/start")[0]?.message.params).toMatchObject({
      cwd: path.join(harness.tempDir, "workspaces", "p2p_ou_guest"),
      approvalPolicy: "never",
      persistExtendedHistory: true
    });
    expect(codexOut(trace, "turn/start")[0]?.message.params).toMatchObject({
      threadId: "guest_thread_1",
      approvalPolicy: "never"
    });
    expect(traceText(codexOut(trace, "turn/start")[0])).toContain("lark_message_id");
    expect(traceText(codexOut(trace, "turn/start")[0])).toContain("m1");
    expect(traceText(codexOut(trace, "turn/start")[0])).toContain("first request");
    expect(codexOut(trace, "turn/steer")[0]?.message.params).toMatchObject({
      threadId: "guest_thread_1",
      expectedTurnId: "turn_1"
    });
    expect(traceText(codexOut(trace, "turn/steer")[0])).toContain("lark_message_id");
    expect(traceText(codexOut(trace, "turn/steer")[0])).toContain("m2");
    expect(traceText(codexOut(trace, "turn/steer")[0])).toContain("second request");
    expectOrder(trace, [
      ["thread/start", (entry) => isCodexMethod(entry, "thread/start")],
      ["typing reaction", (entry) => isLarkRequest(entry, "POST", "/im/v1/messages/m1/reactions")],
      ["turn/start", (entry) => isCodexMethod(entry, "turn/start")],
      ["turn/steer", (entry) => isCodexMethod(entry, "turn/steer")],
      ["clear typing reaction", (entry) => isLarkRequest(entry, "DELETE", "/im/v1/messages/m2/reactions/r_m2")],
      ["final card", (entry) => entry.kind === "lark.out" && entry.method === "PATCH" && traceText(entry).includes("final answer after steer")]
    ]);
  });

  it("keeps queued Lark messages out of Codex when they are recalled before the current turn finishes", async () => {
    const harness = await IntegrationHarness.create(`
{"role":"guest","after":{"method":"turn/start","nth":1},"notify":{"method":"turn/started","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1"}}}}
{"role":"guest","after":{"method":"turn/start","nth":1},"delayMs":120,"notify":{"method":"turn/completed","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1","status":"completed","durationMs":10,"items":[{"type":"agentMessage","id":"agent_done","text":"done","phase":"final_answer"}]}}}}
`);

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_m1", messageId: "m1", text: "long task" }))}}
`);
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "active turn");

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_m2", messageId: "m2", text: "/queue queued task" }))}}
`);
    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("m2")).toMatchObject({ status: "queued" });
    });

    await harness.dispatchLarkJsonl(`
{"event":"im.message.recalled_v1","data":${JSON.stringify(recallEvent({ eventId: "e_recall_m2", messageId: "m2" }))}}
`);

    await harness.waitForExpect(() => {
      expect(harness.repository.getLarkMessageById("m2")).toMatchObject({ status: "recalled" });
    });
    await waitForDelay(180);

    const trace = harness.readTrace();
    expect(codexOut(trace, "turn/start")).toHaveLength(1);
    expect(traceText(codexOut(trace, "turn/start")[0])).not.toContain("queued task");
    expect(larkOut(trace).some((entry) => entry.method === "POST" && entry.path === "/im/v1/messages/m2/reactions")).toBe(true);
    expect(larkOut(trace).some((entry) => entry.method === "DELETE" && entry.path === "/im/v1/messages/m2/reactions/queued_m2")).toBe(true);
  });

  it("covers plan mode questions before accepting and implementing the plan", async () => {
    const harness = await IntegrationHarness.create(`
{"role":"guest","after":{"method":"turn/start","nth":1},"notify":{"method":"turn/started","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1"}}}}
{"role":"guest","after":{"method":"turn/start","nth":1},"request":{"id":"question_1","method":"item/tool/requestUserInput","params":{"threadId":"guest_thread_1","turnId":"turn_1","itemId":"item_question","questions":[{"id":"scope","header":"Scope","question":"Need scope?","isOther":false,"isSecret":false,"options":[{"label":"Full coverage","description":"Exercise the complete flow."},{"label":"Minimal","description":"Only the smallest path."}]}]}}}
{"role":"guest","afterResponse":{"id":"question_1"},"notify":{"method":"item/completed","params":{"threadId":"guest_thread_1","turnId":"turn_1","item":{"type":"plan","text":"Plan ready after question"}}}}
{"role":"guest","afterResponse":{"id":"question_1"},"notify":{"method":"turn/completed","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1","status":"completed","durationMs":12,"items":[{"type":"plan","text":"Plan ready after question"}]}}}}
{"role":"guest","after":{"method":"turn/start","nth":2},"notify":{"method":"turn/started","params":{"threadId":"guest_thread_1","turn":{"id":"turn_2"}}}}
{"role":"guest","after":{"method":"turn/start","nth":2},"notify":{"method":"turn/completed","params":{"threadId":"guest_thread_1","turn":{"id":"turn_2","status":"completed","durationMs":8,"items":[{"type":"agentMessage","id":"implement_done","text":"implemented","phase":"final_answer"}]}}}}
`);

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_plan", messageId: "m_plan", text: "/plan draft the integration test plan" }))}}
`);
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "plan turn/start");
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("Need scope?")),
      "waiting input card"
    );

    const firstTurn = codexOut(harness.readTrace(), "turn/start")[0]!;
    expect(firstTurn.message.params).toMatchObject({
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.5",
          reasoning_effort: "medium",
          developer_instructions: null
        }
      }
    });

    await harness.dispatchLarkJsonl(`
{"event":"card.action.trigger","data":${JSON.stringify(cardActionEvent({
  eventId: "e_answer",
  action: "request_input_submit",
  stateKey: "p2p_ou_guest",
  runId: 1,
  formValue: {
    answer_scope_select: "Full coverage"
  }
}))}}
`);
    await harness.waitForTrace(
      (trace) => codexResponses(trace, "question_1").some((entry) => traceText(entry).includes("Full coverage")),
      "Codex question response"
    );
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("Plan ready after question")),
      "waiting plan card"
    );

    await harness.dispatchLarkJsonl(`
{"event":"card.action.trigger","data":${JSON.stringify(cardActionEvent({
  eventId: "e_implement",
  action: "plan_implement",
  stateKey: "p2p_ou_guest",
  runId: 1,
  formValue: {
    plan_implement_instruction: "cover question flow too"
  }
}))}}
`);
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 2, "implement turn/start");
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.method === "PATCH" && traceText(entry).includes("implemented")),
      "implement final card"
    );

    const trace = harness.readTrace();
    const implementTurn = codexOut(trace, "turn/start")[1]!;
    expect(traceText(implementTurn)).toContain("Implement the plan with following instruction: cover question flow too");
    expectOrder(trace, [
      ["plan turn/start", (entry) => isCodexMethod(entry, "turn/start")],
      ["request user input response", (entry) => isCodexResponse(entry, "question_1")],
      ["waiting plan card", (entry) => entry.kind === "lark.out" && entry.method === "PATCH" && traceText(entry).includes("Plan ready after question")],
      ["implement turn/start", (entry, index, all) => isCodexMethod(entry, "turn/start") && all.slice(0, index).filter((item) => isCodexMethod(item, "turn/start")).length === 1]
    ]);
  });

  it("activates group routing and only forwards mentioned group messages to Codex", async () => {
    const harness = await IntegrationHarness.create(`
{"role":"guest","after":{"method":"turn/start","nth":1},"notify":{"method":"turn/started","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1"}}}}
{"role":"guest","after":{"method":"turn/start","nth":1},"notify":{"method":"turn/completed","params":{"threadId":"guest_thread_1","turn":{"id":"turn_1","status":"completed","durationMs":6,"items":[{"type":"agentMessage","id":"group_done","text":"group done","phase":"final_answer"}]}}}}
`);

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_group_ignored", messageId: "g0", text: "plain before activation", chatType: "group", chatId: "oc_group", senderOpenId: "ou_guest" }))}}
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_group_unauthorized", messageId: "g1", text: "@_bot hello", chatType: "group", chatId: "oc_group", senderOpenId: "ou_guest", mentions: [botMention()] }))}}
`);
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.path === "/im/v1/messages/g1/reply" && traceText(entry).includes("activate")),
      "group unauthorized reply"
    );
    expect(codexOut(harness.readTrace(), "turn/start")).toHaveLength(0);

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_activate", messageId: "g2", text: "/activate at guest", chatType: "group", chatId: "oc_group", senderOpenId: "ou_owner" }))}}
`);
    await harness.waitForTrace(
      (trace) => larkOut(trace).some((entry) => entry.path === "/im/v1/messages/g2/reply" && traceText(entry).includes("Role")),
      "group activation reply"
    );

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_group_no_at", messageId: "g3", text: "plain after activation", chatType: "group", chatId: "oc_group", senderOpenId: "ou_guest" }))}}
`);
    await waitForDelay(30);
    expect(codexOut(harness.readTrace(), "turn/start")).toHaveLength(0);

    await harness.dispatchLarkJsonl(`
{"event":"im.message.receive_v1","data":${JSON.stringify(receiveMessageEvent({ eventId: "e_group_forward", messageId: "g4", text: "@_bot run group task", chatType: "group", chatId: "oc_group", senderOpenId: "ou_guest", mentions: [botMention()] }))}}
`);
    await harness.waitForTrace((trace) => codexOut(trace, "turn/start").length === 1, "group turn/start");

    const groupTurn = codexOut(harness.readTrace(), "turn/start")[0]!;
    expect(traceText(groupTurn)).toContain("run group task");
    expect(traceText(groupTurn)).not.toContain("@_bot");
  });
});

class IntegrationHarness {
  readonly tempDir: string;
  readonly traceFile: string;
  readonly repository: StoreConversationRepository;

  private readonly db: TwinnyDatabase;
  private readonly pool: RoleCodexAppServerPool;
  private readonly consumer: LarkEventConsumer;
  private readonly registered: Record<string, (data: unknown) => unknown> = {};
  private disposed = false;

  private constructor(options: {
    tempDir: string;
    traceFile: string;
    db: TwinnyDatabase;
    repository: StoreConversationRepository;
    pool: RoleCodexAppServerPool;
    consumer: LarkEventConsumer;
    registered: Record<string, (data: unknown) => unknown>;
  }) {
    this.tempDir = options.tempDir;
    this.traceFile = options.traceFile;
    this.db = options.db;
    this.repository = options.repository;
    this.pool = options.pool;
    this.consumer = options.consumer;
    Object.assign(this.registered, options.registered);
  }

  static async create(codexScriptJsonl: string): Promise<IntegrationHarness> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-integration-"));
    const traceFile = path.join(tempDir, "trace.jsonl");
    const scriptFile = path.join(tempDir, "codex-script.jsonl");
    fs.writeFileSync(scriptFile, normalizeJsonl(codexScriptJsonl), "utf8");
    const fakeCodexBinary = createFakeCodexBinary(tempDir, traceFile, scriptFile);
    const config = createIntegrationConfig(tempDir, fakeCodexBinary);
    const db = openTwinnyDatabase(path.join(tempDir, "sqlite", "twinny.db"));
    const repository = createConversationRepository(db);
    const pool = new RoleCodexAppServerPool({
      binary: fakeCodexBinary,
      roles: config.roles,
      requestTimeoutMs: 2_000,
      clientVersion: "integration-test",
      env: {
        PATH: process.env.PATH,
        HOME: tempDir
      }
    });
    await pool.startAll();

    const larkApi = new FakeLarkApi(traceFile);
    const tokenManager = new TenantAccessTokenManager({
      appId: config.lark.appId,
      appSecret: "secret",
      fetch: larkApi.fetch,
      now: () => 1_000_000
    });
    const openApiClient = new LarkOpenApiClient({
      tokenManager,
      fetch: larkApi.fetch,
      maxRetries: 0
    });
    const larkSender = new LarkMessageSender({ openApiClient });
    const manager = new ConversationManager({
      config,
      repository: adaptConversationRepository(repository),
      workspaces: WorkspaceManager.fromTwinnyHome(tempDir),
      roles: {
        codexHomeFor: (role) => config.roles[role].codexHome
      },
      codex: adaptCodexPool(pool),
      lark: adaptLarkSender(larkSender, config),
      larkUsers: new LarkUserDirectory({ openApiClient }),
      larkChats: new LarkChatDirectory({ openApiClient }),
      larkFiles: new LarkFileDownloader({ openApiClient }),
      larkMessages: new LarkMessageReader({ openApiClient }),
      botOpenId: "ou_bot",
      logger: silentLogger(),
      nameLookupFailureTtlMs: 1
    });
    const registered: Record<string, (data: unknown) => unknown> = {};
    const dispatcher: EventDispatcherLike = {
      register(handles) {
        Object.assign(registered, handles);
        return this;
      }
    };
    const wsClient: WsClientLike = {
      start: () => undefined,
      close: () => undefined
    };
    const consumer = new LarkEventConsumer({
      appId: config.lark.appId,
      appSecret: "secret",
      warmTenantToken: false,
      botOpenId: "ou_bot",
      onMessage: (message) => {
        manager.submitIncoming(message);
      },
      onMessageRecall: (recall) => {
        manager.submitMessageRecall(recall);
      },
      onBotMenu: (action) => {
        manager.submitBotMenuAction(action);
      },
      onCardAction: (action) => {
        manager.submitCardAction(action);
      },
      maxMessageAgeMs: 60_000,
      now: () => 1_000,
      eventDispatcherFactory: () => dispatcher,
      wsClientFactory: () => wsClient
    });
    await consumer.start();

    const harness = new IntegrationHarness({
      tempDir,
      traceFile,
      db,
      repository,
      pool,
      consumer,
      registered
    });
    larkApi.setMessageObserver((raw) => harness.rememberMessageRaw(raw));
    harnesses.push(harness);
    return harness;
  }

  async dispatchLarkJsonl(jsonl: string): Promise<void> {
    for (const item of parseJsonl<LarkEventInput>(jsonl)) {
      if (item.atMs && item.atMs > 0) {
        await waitForDelay(item.atMs);
      }
      this.rememberMessageRaw(item.data);
      const handler = this.registered[item.event];
      if (!handler) {
        throw new Error(`No Lark event handler registered for ${item.event}`);
      }
      await handler(item.data);
    }
  }

  async waitForTrace(predicate: (trace: TraceEntry[]) => boolean, label: string, timeoutMs = 1_500): Promise<void> {
    await this.waitForExpect(() => {
      const trace = this.readTrace();
      expect(predicate(trace), `${label}\n${JSON.stringify(trace, null, 2)}`).toBe(true);
    }, timeoutMs);
  }

  async waitForExpect(assertion: () => void, timeoutMs = 1_500): Promise<void> {
    const startedAt = Date.now();
    let lastError: unknown;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
        await waitForDelay(5);
      }
    }
    throw lastError;
  }

  readTrace(): TraceEntry[] {
    if (!fs.existsSync(this.traceFile)) {
      return [];
    }
    return fs
      .readFileSync(this.traceFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEntry);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.consumer.stop({ force: true }).catch(() => undefined);
    await this.pool.stopAll().catch(() => undefined);
    this.db.close();
    fs.rmSync(this.tempDir, { recursive: true, force: true });
  }

  private rememberMessageRaw(raw: unknown): void {
    FakeLarkApi.rememberGlobalMessage(raw);
  }
}

class FakeLarkApi {
  private static readonly messageRawById = new Map<string, unknown>();
  private messageObserver?: (raw: unknown) => void;

  constructor(private readonly traceFile: string) {}

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const apiPath = url.pathname.replace(/^\/open-apis/, "");
    const method = init?.method ?? "GET";
    const body = parseRequestBody(init?.body);
    appendTrace(this.traceFile, {
      kind: "lark.out",
      method,
      path: apiPath,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      bodyContentJson: parseBodyContent(body)
    });

    if (apiPath === "/auth/v3/tenant_access_token/internal") {
      return jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
    }
    if (apiPath === "/bot/v3/info") {
      return jsonResponse({ code: 0, data: { open_id: "ou_bot" } });
    }
    const contactMatch = /^\/contact\/v3\/users\/([^/]+)$/.exec(apiPath);
    if (contactMatch) {
      const openId = decodeURIComponent(contactMatch[1]!);
      return jsonResponse({
        code: 0,
        data: {
          user: {
            name: openId === "ou_owner" ? "Owner User" : "Guest User"
          }
        }
      });
    }
    const chatMatch = /^\/im\/v1\/chats\/([^/]+)$/.exec(apiPath);
    if (chatMatch && method === "GET") {
      return jsonResponse({
        code: 0,
        data: {
          chat: {
            chat_id: decodeURIComponent(chatMatch[1]!),
            name: "Team Room",
            chat_mode: "group",
            group_message_type: "chat"
          }
        }
      });
    }
    if (apiPath === "/im/v1/messages/mget") {
      const ids = (url.searchParams.get("message_ids") ?? "").split(",").filter(Boolean);
      return jsonResponse({
        code: 0,
        data: {
          items: ids.map((id) => this.fetchedMessage(id)).filter(Boolean)
        }
      });
    }
    const readUsersMatch = /^\/im\/v1\/messages\/([^/]+)\/read_users$/.exec(apiPath);
    if (readUsersMatch) {
      return jsonResponse({ code: 0, data: { items: [], has_more: false } });
    }
    const reactionCreateMatch = /^\/im\/v1\/messages\/([^/]+)\/reactions$/.exec(apiPath);
    if (reactionCreateMatch && method === "POST") {
      const messageId = decodeURIComponent(reactionCreateMatch[1]!);
      const reactionType = asRecord(body)?.reaction_type;
      const emoji = asRecord(reactionType)?.emoji_type;
      const prefix = emoji === "OneSecond" ? "queued" : emoji === "DONE" ? "done" : "r";
      return jsonResponse({ code: 0, data: { reaction_id: `${prefix}_${messageId}` } });
    }
    if (/^\/im\/v1\/messages\/[^/]+\/reactions\/[^/]+$/.test(apiPath) && method === "DELETE") {
      return jsonResponse({ code: 0, data: {} });
    }
    const replyMatch = /^\/im\/v1\/messages\/([^/]+)\/reply$/.exec(apiPath);
    if (replyMatch && method === "POST") {
      const sourceMessageId = decodeURIComponent(replyMatch[1]!);
      const messageId = `reply_${sourceMessageId}_${nextLarkId()}`;
      return jsonResponse({ code: 0, data: { message_id: messageId, thread_id: `thread_${messageId}` } });
    }
    if (apiPath === "/im/v1/messages" && method === "POST") {
      const messageId = `send_${nextLarkId()}`;
      return jsonResponse({ code: 0, data: { message_id: messageId, thread_id: `thread_${messageId}` } });
    }
    const messagePatchOrDeleteMatch = /^\/im\/v1\/messages\/([^/]+)$/.exec(apiPath);
    if (messagePatchOrDeleteMatch && (method === "PATCH" || method === "DELETE")) {
      return jsonResponse({ code: 0, data: { message_id: decodeURIComponent(messagePatchOrDeleteMatch[1]!) } });
    }
    const resourceMatch = /^\/im\/v1\/messages\/[^/]+\/resources\/[^/]+$/.exec(apiPath);
    if (resourceMatch && method === "GET") {
      return binaryResponse(Buffer.from("fake-resource"), "text/plain");
    }
    if (apiPath === "/im/v1/images" || apiPath === "/im/v1/files") {
      return jsonResponse({ code: 0, data: { image_key: `img_${nextLarkId()}`, file_key: `file_${nextLarkId()}` } });
    }
    return jsonResponse({ code: 0, data: {} });
  };

  setMessageObserver(observer: (raw: unknown) => void): void {
    this.messageObserver = observer;
  }

  static rememberGlobalMessage(raw: unknown): void {
    const message = eventMessage(raw);
    const messageId = typeof message?.message_id === "string" ? message.message_id : undefined;
    if (messageId) {
      FakeLarkApi.messageRawById.set(messageId, raw);
    }
  }

  private fetchedMessage(messageId: string): unknown {
    const raw = FakeLarkApi.messageRawById.get(messageId);
    const message = eventMessage(raw);
    if (!message) {
      return undefined;
    }
    this.messageObserver?.(raw);
    return {
      ...message,
      msg_type: message.message_type,
      body: {
        content: message.content
      }
    };
  }
}

let larkId = 0;

function nextLarkId(): number {
  larkId += 1;
  return larkId;
}

function adaptConversationRepository(repository: StoreConversationRepository): ManagerConversationRepository {
  return {
    findByConversationKey: (conversationKey) => repository.getByConversationKey(conversationKey) ?? null,
    create: repository.create.bind(repository),
    updateThreadBinding: repository.updateThreadBinding.bind(repository),
    updateConversationSettings: repository.updateConversationSettings.bind(repository),
    markThreadHasRollout: repository.markThreadHasRollout.bind(repository),
    getCodexThreadById: repository.getCodexThreadById.bind(repository),
    getCodexThreadByConversationAndLarkThread: repository.getCodexThreadByConversationAndLarkThread.bind(repository),
    getLarkMessageById: repository.getLarkMessageById.bind(repository),
    getLarkMessageByEventId: repository.getLarkMessageByEventId.bind(repository),
    listUnfinishedLarkMessages: repository.listUnfinishedLarkMessages.bind(repository),
    upsertCodexThread: repository.upsertCodexThread.bind(repository),
    replaceCodexThreadForLarkThread: repository.replaceCodexThreadForLarkThread.bind(repository),
    updateCodexThreadTokenUsage: repository.updateCodexThreadTokenUsage.bind(repository),
    updateCodexThreadCard: repository.updateCodexThreadCard.bind(repository),
    updateCodexThreadMode: repository.updateCodexThreadMode.bind(repository),
    updateCodexThreadStatus: repository.updateCodexThreadStatus.bind(repository),
    getCodexThreadWorkStats: repository.getCodexThreadWorkStats.bind(repository),
    insertLarkMessage: repository.insertLarkMessage.bind(repository),
    markLarkMessageQueued: repository.markLarkMessageQueued.bind(repository),
    markLarkMessageRecalled: repository.markLarkMessageRecalled.bind(repository),
    updateQueuedLarkMessage: repository.updateQueuedLarkMessage.bind(repository),
    markLarkMessagesProcessing: repository.markLarkMessagesProcessing.bind(repository),
    markLarkMessagesSteered: repository.markLarkMessagesSteered.bind(repository),
    markLarkMessagesCompleted: repository.markLarkMessagesCompleted.bind(repository),
    markLarkMessagesFailed: repository.markLarkMessagesFailed.bind(repository),
    markLarkMessagesInterrupted: repository.markLarkMessagesInterrupted.bind(repository),
    markLarkMessagesCleared: repository.markLarkMessagesCleared.bind(repository)
  };
}

function adaptCodexPool(pool: RoleCodexAppServerPool): CodexBridge {
  return {
    startThread: async ({ role, cwd }: { role: RoleName; cwd: string }) => {
      const response = await pool.get(role).startThread(cwd);
      return { threadId: response.thread.id };
    },
    resumeThread: async ({ role, threadId, cwd }: { role: RoleName; threadId: string; cwd: string }) => {
      const response = await pool.get(role).resumeThread(threadId, cwd);
      return { threadId: response.thread.id };
    },
    startTurn: async ({
      role,
      threadId,
      input,
      cwd,
      mode,
      model,
      effort,
      onTurnStarted,
      onAgentMessage,
      onTokenUsage,
      onPlanUpdated,
      onRequestUserInput
    }: {
      role: RoleName;
      threadId: string;
      input: CodexTurnInput;
      cwd: string;
      mode?: CodexThreadMode;
      model?: string;
      effort?: string;
      onTurnStarted?: (turnId: string) => Promise<void> | void;
      onAgentMessage?: (message: CodexAgentMessage) => Promise<void> | void;
      onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
      onPlanUpdated?: (plan: CodexPlanUpdate) => Promise<void> | void;
      onRequestUserInput?: (
        request: CodexRequestUserInputRequest,
        responder: CodexRequestUserInputResponder
      ) => Promise<void> | void;
    }) =>
      pool.get(role).startTurn({
        threadId,
        ...(typeof input === "string" ? { text: input } : { input }),
        cwd,
        mode,
        model,
        effort,
        onTurnStarted,
        onAgentMessage,
        onTokenUsage,
        onPlanUpdated,
        onRequestUserInput
      }),
    compactThread: async ({ role, threadId, cwd, onTurnStarted, onTokenUsage }) =>
      pool.get(role).compactThread({ threadId, cwd, onTurnStarted, onTokenUsage }),
    steerTurn: async ({ role, threadId, turnId, input }) => {
      await pool.get(role).steerTurn({
        threadId,
        turnId,
        ...(typeof input === "string" ? { text: input } : { input })
      });
    },
    interruptTurn: async ({ role, threadId, turnId }) => {
      await pool.get(role).interruptTurn({ threadId, turnId });
    },
    readAccountRateLimits: async ({ role }) => pool.get(role).readAccountRateLimits()
  };
}

function adaptLarkSender(sender: LarkMessageSender, config: TwinnyConfig): LarkResponder {
  return {
    addTypingReaction: (messageId: string): Promise<LarkReactionHandle | null> =>
      sender.createReaction(messageId, config.lark.workingReaction),
    addCompletedReaction: (messageId: string): Promise<LarkReactionHandle | null> =>
      sender.createReaction(messageId, config.lark.completedReaction),
    addQueuedReaction: (messageId: string): Promise<LarkReactionHandle | null> =>
      sender.createReaction(messageId, config.lark.queuedReaction),
    removeReaction: (handle) => sender.deleteReaction(handle),
    replyText: (messageId, text, options) => sender.replyText(messageId, text, options),
    replyMarkdown: (messageId, markdown, options) => sender.replyMarkdown(messageId, markdown, options),
    replyPost: (messageId, content, options) => sender.replyPost(messageId, content, options),
    replyFile: (messageId, fileKey) => sender.replyFile(messageId, fileKey),
    sendTextToOpenId: async (openId, text) => {
      await sender.sendTextToOpenId(openId, text);
    },
    sendCardToChatId: (chatId, card, options) => sender.sendInteractiveCardToChatId(chatId, card, options),
    forwardThreadToThread: (threadId, receiveThreadId, options) =>
      sender.forwardThreadToThread(threadId, receiveThreadId, options),
    replyCard: (messageId, card, options) => sender.replyInteractiveCard(messageId, card, options),
    patchCard: (messageId, card) => sender.patchInteractiveCard(messageId, card),
    recallMessage: (messageId) => sender.deleteMessage(messageId),
    getMessageReadOpenIds: (messageId) => sender.listMessageReadOpenIds(messageId)
  };
}

function createIntegrationConfig(tempDir: string, fakeCodexBinary: string): TwinnyConfig {
  return createTwinnyConfig({
    home: tempDir,
    codex: {
      binary: fakeCodexBinary,
      appServerListen: "stdio://"
    },
    lark: {
      appId: "cli_integration",
      appSecretRef: "test:lark-secret",
      agentMessageMode: "card",
      iconImageKey: "img_logo"
    },
    owner: {
      openId: "ou_owner",
      displayName: "Owner User"
    },
    roles: {
      owner: { codexHome: path.join(tempDir, "roles", "owner", "codex") },
      guest: { codexHome: path.join(tempDir, "roles", "guest", "codex") }
    }
  });
}

function createFakeCodexBinary(tempDir: string, traceFile: string, scriptFile: string): string {
  const binary = path.join(tempDir, "fake-codex.mjs");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const traceFile = ${JSON.stringify(traceFile)};
const scriptFile = ${JSON.stringify(scriptFile)};
const script = fs.readFileSync(scriptFile, "utf8")
  .split(/\\r?\\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const role = process.env.CODEX_HOME && process.env.CODEX_HOME.includes("/owner/") ? "owner" : "guest";
const counts = new Map();
const rl = readline.createInterface({ input: process.stdin });

function append(entry) {
  fs.appendFileSync(traceFile, JSON.stringify({ ...entry, at: Date.now() }) + "\\n");
}

function send(message, delayMs = 0) {
  const write = () => process.stdout.write(JSON.stringify(message) + "\\n");
  if (delayMs > 0) {
    setTimeout(write, delayMs);
    return;
  }
  write();
}

function nextCount(method) {
  const next = (counts.get(method) ?? 0) + 1;
  counts.set(method, next);
  return next;
}

function matches(trigger, message, method, nth) {
  if (!trigger) return false;
  if (trigger.role && trigger.role !== role) return false;
  if (trigger.method && trigger.method !== method) return false;
  if (trigger.nth && trigger.nth !== nth) return false;
  if (trigger.id && trigger.id !== message.id) return false;
  return true;
}

function defaultResult(message, method, nth) {
  if (method === "initialize") {
    return {
      userAgent: "fake-codex",
      codexHome: process.env.CODEX_HOME,
      platformFamily: "unix",
      platformOs: "macos"
    };
  }
  if (method === "thread/start") {
    return { thread: { id: role + "_thread_" + nth } };
  }
  if (method === "thread/resume") {
    return { thread: { id: message.params.threadId } };
  }
  if (method === "turn/start") {
    return { turn: { id: "turn_" + nth } };
  }
  if (method === "thread/compact/start") {
    return {};
  }
  if (method === "turn/steer" || method === "turn/interrupt") {
    return {};
  }
  if (method === "account/rateLimits/read") {
    return { rateLimits: { primary: { usedPercent: 1 } }, rateLimitsByLimitId: null };
  }
  return {};
}

function emitAction(action) {
  if (action.notify) {
    send({ method: action.notify.method, params: action.notify.params }, action.delayMs ?? 0);
  }
  if (action.request) {
    send({ id: action.request.id, method: action.request.method, params: action.request.params }, action.delayMs ?? 0);
  }
}

function handleRequest(message) {
  const method = message.method;
  const nth = nextCount(method);
  const custom = script.find((action) => matches(action.on, message, method, nth));
  if (custom?.error) {
    send({ id: message.id, error: custom.error });
  } else {
    send({ id: message.id, result: custom?.reply ?? defaultResult(message, method, nth) });
  }
  for (const action of script) {
    if (matches(action.after, message, method, nth)) {
      emitAction(action);
    }
  }
}

function handleResponse(message) {
  const key = "response:" + String(message.id);
  const nth = nextCount(key);
  for (const action of script) {
    if (matches(action.afterResponse, message, key, nth)) {
      emitAction(action);
    }
  }
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  append({ kind: "codex.out", role, id: message.id, method: message.method ?? null, message });
  if (message.method && message.id !== undefined) {
    handleRequest(message);
    return;
  }
  if (!message.method && message.id !== undefined) {
    handleResponse(message);
  }
});
`,
    { mode: 0o755 }
  );
  return binary;
}

function receiveMessageEvent(options: {
  eventId: string;
  messageId: string;
  text: string;
  senderOpenId?: string;
  chatType?: "p2p" | "group" | "topic_group";
  chatId?: string;
  mentions?: Array<Record<string, unknown>>;
}): unknown {
  const senderOpenId = options.senderOpenId ?? "ou_guest";
  const chatType = options.chatType ?? "p2p";
  return {
    event_id: options.eventId,
    sender: {
      sender_id: {
        open_id: senderOpenId
      },
      sender_type: "user",
      sender_name: senderOpenId === "ou_owner" ? "Owner User" : "Guest User"
    },
    message: {
      message_id: options.messageId,
      create_time: "1000",
      chat_id: options.chatId ?? (chatType === "p2p" ? senderOpenId : "oc_group"),
      chat_type: chatType,
      message_type: "text",
      mentions: options.mentions,
      content: JSON.stringify({ text: options.text })
    }
  };
}

function recallEvent(options: { eventId: string; messageId: string }): unknown {
  return {
    header: { event_id: options.eventId },
    event: {
      message_id: options.messageId,
      chat_id: "oc_ignored",
      recall_time: "1100"
    }
  };
}

function cardActionEvent(options: {
  eventId: string;
  action: string;
  stateKey: string;
  runId: number;
  formValue?: Record<string, unknown>;
}): unknown {
  return {
    header: { event_id: options.eventId },
    event: {
      operator: { open_id: "ou_guest" },
      action: {
        tag: "button",
        value: {
          twinny: true,
          action: options.action,
          stateKey: options.stateKey,
          runId: options.runId
        },
        form_value: options.formValue ?? {}
      }
    }
  };
}

function botMention(): Record<string, unknown> {
  return {
    key: "@_bot",
    id: {
      open_id: "ou_bot"
    },
    name: "Twinny"
  };
}

function parseJsonl<T>(jsonl: string): T[] {
  return normalizeJsonl(jsonl)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function normalizeJsonl(jsonl: string): string {
  return jsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function appendTrace(traceFile: string, entry: Record<string, unknown>): void {
  fs.appendFileSync(traceFile, `${JSON.stringify({ ...entry, at: Date.now() })}\n`, "utf8");
}

function parseRequestBody(body: string | FormData | undefined): unknown {
  if (typeof body !== "string") {
    return body === undefined ? undefined : { formData: true };
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function parseBodyContent(body: unknown): unknown {
  const record = asRecord(body);
  if (!record || typeof record.content !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(record.content);
  } catch {
    return record.content;
  }
}

function eventMessage(raw: unknown): Record<string, unknown> | undefined {
  const root = asRecord(raw);
  const event = asRecord(root?.event) ?? root;
  return asRecord(event?.message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)).buffer
  };
}

function binaryResponse(body: Buffer, contentType: string): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get(name: string) {
        return name.toLowerCase() === "content-type" ? contentType : null;
      }
    },
    json: async () => ({}),
    text: async () => body.toString("utf8"),
    arrayBuffer: async () => new Uint8Array(body).buffer
  };
}

function codexOut(trace: TraceEntry[], method: string): CodexTraceEntry[] {
  return trace.filter((entry): entry is CodexTraceEntry => isCodexMethod(entry, method));
}

function codexResponses(trace: TraceEntry[], id: string): CodexTraceEntry[] {
  return trace.filter((entry): entry is CodexTraceEntry => isCodexResponse(entry, id));
}

function larkOut(trace: TraceEntry[]): LarkTraceEntry[] {
  return trace.filter((entry): entry is LarkTraceEntry => entry.kind === "lark.out");
}

function isCodexMethod(entry: TraceEntry, method: string): entry is CodexTraceEntry {
  return entry.kind === "codex.out" && entry.method === method;
}

function isCodexResponse(entry: TraceEntry, id: string): entry is CodexTraceEntry {
  return entry.kind === "codex.out" && entry.id === id && entry.method === null;
}

function isLarkRequest(entry: TraceEntry, method: string, path: string): entry is LarkTraceEntry {
  return entry.kind === "lark.out" && entry.method === method && entry.path === path;
}

function traceText(entry: TraceEntry | undefined): string {
  return JSON.stringify(entry ?? {});
}

function expectOrder(
  trace: TraceEntry[],
  checkpoints: Array<[string, (entry: TraceEntry, index: number, all: TraceEntry[]) => boolean]>
): void {
  let cursor = -1;
  for (const [label, predicate] of checkpoints) {
    const index = trace.findIndex((entry, itemIndex) => itemIndex > cursor && predicate(entry, itemIndex, trace));
    expect(index, label).toBeGreaterThan(cursor);
    cursor = index;
  }
}

function waitForDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function silentLogger(): ConstructorParameters<typeof ConversationManager>[0]["logger"] {
  return ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  } as unknown) as ConstructorParameters<typeof ConversationManager>[0]["logger"];
}

interface LarkEventInput {
  atMs?: number;
  event: string;
  data: unknown;
}

type TraceEntry = CodexTraceEntry | LarkTraceEntry;

interface CodexTraceEntry {
  kind: "codex.out";
  at: number;
  role: RoleName;
  id: string | number;
  method: string | null;
  message: {
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };
}

interface LarkTraceEntry {
  kind: "lark.out";
  at: number;
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  bodyContentJson?: unknown;
}
