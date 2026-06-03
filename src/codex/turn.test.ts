import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexProtocolClient } from "./protocol.js";
import {
  buildTurnInterruptParams,
  buildTurnStartParams,
  buildTurnSteerParams,
  DANGER_FULL_ACCESS_SANDBOX_POLICY,
  dynamicToolTextResponse,
  handleTurnServerRequest,
  startCodexTurn,
  TurnOutputAccumulator
} from "./turn.js";

describe("codex turn payloads", () => {
  it("builds turn/start text input with minimal Twinny runtime overrides", () => {
    expect(
      buildTurnStartParams({
        threadId: "thread_123",
        text: "hello",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1"
      })
    ).toEqual({
      threadId: "thread_123",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      cwd: "/tmp/twinny/workspaces/p2p_ou_1",
      approvalPolicy: "never"
    });
  });

  it("builds an explicit sandbox policy override when supplied", () => {
    expect(
      buildTurnStartParams({
        threadId: "thread_123",
        text: "hello",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        sandboxPolicy: DANGER_FULL_ACCESS_SANDBOX_POLICY
      })
    ).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" }
    });
  });

  it("builds default collaboration mode when mode is explicit", () => {
    expect(
      buildTurnStartParams({
        threadId: "thread_123",
        text: "implement",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        mode: "default"
      })
    ).toMatchObject({
      collaborationMode: {
        mode: "default",
        settings: {
          developer_instructions: null
        }
      }
    });
  });

  it("injects the current thread name into turn/start text input", () => {
    expect(
      buildTurnStartParams({
        threadId: "thread_123",
        text: "hello",
        currentThreadName: "A&B <work>",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1"
      })
    ).toMatchObject({
      input: [
        {
          type: "text",
          text: "<current_thread_name>A&amp;B &lt;work&gt;</current_thread_name>\nhello",
          text_elements: []
        }
      ]
    });
  });

  it("builds turn/steer text input with the active turn precondition", () => {
    expect(
      buildTurnSteerParams({
        threadId: "thread_123",
        turnId: "turn_1",
        text: "steer this turn"
      })
    ).toEqual({
      threadId: "thread_123",
      input: [{ type: "text", text: "steer this turn", text_elements: [] }],
      expectedTurnId: "turn_1"
    });
  });

  it("passes local image user input items through", () => {
    const input = [
      { type: "text" as const, text: "inspect ", text_elements: [] as [] },
      { type: "localImage" as const, path: "/tmp/a.png", detail: null }
    ];

    expect(
      buildTurnStartParams({
        threadId: "thread_123",
        input,
        cwd: "/tmp/twinny/workspaces/p2p_ou_1"
      })
    ).toMatchObject({
      input
    });
  });

  it("builds turn/interrupt params", () => {
    expect(buildTurnInterruptParams({ threadId: "thread_123", turnId: "turn_1" })).toEqual({
      threadId: "thread_123",
      turnId: "turn_1"
    });
  });
});

describe("handleTurnServerRequest", () => {
  it("handles set_thread_name dynamic tool calls without enforcing title length", async () => {
    const protocol = new FakeProtocol();
    const onSetThreadName = vi.fn(async (request) =>
      dynamicToolTextResponse(true, `updated ${request.name}`)
    );

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onSetThreadName
      },
      {
        id: "req-1",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_1",
          namespace: "twinny",
          tool: "set_thread_name",
          arguments: { name: "  this is a very long thread name with many words  " }
        }
      }
    );

    await Promise.resolve();

    expect(onSetThreadName).toHaveBeenCalledWith({
      requestId: "req-1",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_1",
      name: "this is a very long thread name with many words",
      rawArguments: { name: "  this is a very long thread name with many words  " }
    });
    expect(protocol.respondMock).toHaveBeenCalledWith("req-1", {
      success: true,
      contentItems: [{ type: "inputText", text: "updated this is a very long thread name with many words" }]
    });
    expect(protocol.respondErrorMock).not.toHaveBeenCalled();
  });

  it("returns dynamic tool failure for empty set_thread_name input", () => {
    const protocol = new FakeProtocol();
    const onSetThreadName = vi.fn();

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onSetThreadName
      },
      {
        id: "req-2",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_2",
          namespace: "twinny",
          tool: "set_thread_name",
          arguments: { name: "   " }
        }
      }
    );

    expect(onSetThreadName).not.toHaveBeenCalled();
    expect(protocol.respondMock).toHaveBeenCalledWith("req-2", {
      success: false,
      contentItems: [{ type: "inputText", text: "Invalid thread name: expected a non-empty name string." }]
    });
  });

  it("dispatches Twinny dynamic tool calls with parsed arguments", async () => {
    const protocol = new FakeProtocol();
    const onDynamicToolCall = vi.fn(async (request) =>
      dynamicToolTextResponse(true, `${request.tool}:${request.callId}`)
    );

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-list",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_list",
          namespace: "twinny",
          tool: "list_threads",
          arguments: { page: 2, page_size: 50 }
        }
      }
    );

    await Promise.resolve();

    expect(onDynamicToolCall).toHaveBeenCalledWith({
      requestId: "req-list",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_list",
      tool: "list_threads",
      page: 2,
      pageSize: 50,
      rawArguments: { page: 2, page_size: 50 }
    });
    expect(protocol.respondMock).toHaveBeenCalledWith("req-list", {
      success: true,
      contentItems: [{ type: "inputText", text: "list_threads:call_list" }]
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-search",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_search",
          namespace: "twinny",
          tool: "search_threads",
          arguments: { searchTerm: "  rollout plan  ", cursor: null, limit: 250, sortKey: null, sortDirection: "asc" }
        }
      }
    );

    await Promise.resolve();

    expect(onDynamicToolCall).toHaveBeenLastCalledWith({
      requestId: "req-search",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_search",
      tool: "search_threads",
      searchTerm: "rollout plan",
      cursor: null,
      limit: 100,
      sortKey: "created_at",
      sortDirection: "asc",
      rawArguments: { searchTerm: "  rollout plan  ", cursor: null, limit: 250, sortKey: null, sortDirection: "asc" }
    });
    expect(protocol.respondMock).toHaveBeenCalledWith("req-search", {
      success: true,
      contentItems: [{ type: "inputText", text: "search_threads:call_search" }]
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-new-thread",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_new_thread",
          namespace: "twinny",
          tool: "new_thread",
          arguments: {
            workspace: "/tmp/work",
            model: "gpt-5.5",
            effort: "high",
            fork: true,
            mode: "plan",
            name: "Child Thread",
            initial_message: "start here"
          }
        }
      }
    );

    await Promise.resolve();

    expect(onDynamicToolCall).toHaveBeenLastCalledWith({
      requestId: "req-new-thread",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_new_thread",
      tool: "new_thread",
      workspace: "/tmp/work",
      model: "gpt-5.5",
      effort: "high",
      fork: true,
      mode: "plan",
      name: "Child Thread",
      initialMessage: "start here",
      rawArguments: {
        workspace: "/tmp/work",
        model: "gpt-5.5",
        effort: "high",
        fork: true,
        mode: "plan",
        name: "Child Thread",
        initial_message: "start here"
      }
    });
    expect(protocol.respondMock).toHaveBeenCalledWith("req-new-thread", {
      success: true,
      contentItems: [{ type: "inputText", text: "new_thread:call_new_thread" }]
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-tell",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_tell",
          namespace: "twinny",
          tool: "tell_thread",
          arguments: { thread_id: "thread_target", msg: "please check this" }
        }
      }
    );

    await Promise.resolve();

    expect(onDynamicToolCall).toHaveBeenLastCalledWith({
      requestId: "req-tell",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_tell",
      tool: "tell_thread",
      targetThreadId: "thread_target",
      message: "please check this",
      mode: "queue",
      rawArguments: { thread_id: "thread_target", msg: "please check this" }
    });
    expect(protocol.respondMock).toHaveBeenCalledWith("req-tell", {
      success: true,
      contentItems: [{ type: "inputText", text: "tell_thread:call_tell" }]
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-tell-steer",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_tell_steer",
          namespace: "twinny",
          tool: "tell_thread",
          arguments: { thread_id: "thread_target", msg: "urgent check", mode: "steer" }
        }
      }
    );

    await Promise.resolve();

    expect(onDynamicToolCall).toHaveBeenLastCalledWith({
      requestId: "req-tell-steer",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_tell_steer",
      tool: "tell_thread",
      targetThreadId: "thread_target",
      message: "urgent check",
      mode: "steer",
      rawArguments: { thread_id: "thread_target", msg: "urgent check", mode: "steer" }
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-add-cron",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_add_cron",
          namespace: "twinny",
          tool: "add_cron",
          arguments: { cron_exp: "*/5 * * * *", msg: "ping", thread_id: "thread_target" }
        }
      }
    );

    await Promise.resolve();

    expect(onDynamicToolCall).toHaveBeenLastCalledWith({
      requestId: "req-add-cron",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_add_cron",
      tool: "add_cron",
      cronExpression: "*/5 * * * *",
      message: "ping",
      targetThreadId: "thread_target",
      rawArguments: { cron_exp: "*/5 * * * *", msg: "ping", thread_id: "thread_target" }
    });
    expect(protocol.respondMock).toHaveBeenCalledWith("req-add-cron", {
      success: true,
      contentItems: [{ type: "inputText", text: "add_cron:call_add_cron" }]
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-list-cron",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_list_cron",
          namespace: "twinny",
          tool: "list_cron",
          arguments: {}
        }
      }
    );

    await Promise.resolve();

    expect(onDynamicToolCall).toHaveBeenLastCalledWith({
      requestId: "req-list-cron",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_list_cron",
      tool: "list_cron",
      rawArguments: {}
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-del-cron",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_del_cron",
          namespace: "twinny",
          tool: "del_cron",
          arguments: { cron_id: 12 }
        }
      }
    );

    await Promise.resolve();

    expect(onDynamicToolCall).toHaveBeenLastCalledWith({
      requestId: "req-del-cron",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_del_cron",
      tool: "del_cron",
      cronId: 12,
      rawArguments: { cron_id: 12 }
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-watch-lark-url",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_watch",
          namespace: "twinny",
          tool: "watch_lark_url",
          arguments: { file_type: "docx", file_token: "doc_token", mode: "all", url: "https://example.feishu.cn/docx/doc_token" }
        }
      }
    );

    await Promise.resolve();

    expect(onDynamicToolCall).toHaveBeenLastCalledWith({
      requestId: "req-watch-lark-url",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_watch",
      tool: "watch_lark_url",
      watchMode: "all",
      fileType: "docx",
      fileToken: "doc_token",
      watchUrl: "https://example.feishu.cn/docx/doc_token",
      rawArguments: { file_type: "docx", file_token: "doc_token", mode: "all", url: "https://example.feishu.cn/docx/doc_token" }
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-list-lark-watchers",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_list_watchers",
          namespace: "twinny",
          tool: "list_lark_url_watchers",
          arguments: {}
        }
      }
    );

    await Promise.resolve();

    expect(onDynamicToolCall).toHaveBeenLastCalledWith({
      requestId: "req-list-lark-watchers",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_list_watchers",
      tool: "list_lark_url_watchers",
      rawArguments: {}
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-rm-lark-watchers",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_rm_watchers",
          namespace: "twinny",
          tool: "rm_lark_url_watchers",
          arguments: { watcher_id: 3 }
        }
      }
    );

    await Promise.resolve();

    expect(onDynamicToolCall).toHaveBeenLastCalledWith({
      requestId: "req-rm-lark-watchers",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_rm_watchers",
      tool: "rm_lark_url_watchers",
      watcherId: 3,
      rawArguments: { watcher_id: 3 }
    });
  });

  it("validates Twinny dynamic tool arguments before dispatch", () => {
    const protocol = new FakeProtocol();
    const onDynamicToolCall = vi.fn();

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-search",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_search",
          namespace: "twinny",
          tool: "search_threads",
          arguments: { searchTerm: "   ", sortKey: "name" }
        }
      }
    );

    expect(onDynamicToolCall).not.toHaveBeenCalled();
    expect(protocol.respondMock).toHaveBeenCalledWith("req-search", {
      success: false,
      contentItems: [{
        type: "inputText",
        text: "Invalid search_threads arguments: searchTerm must be a non-empty string, cursor must be a string or null, limit must be an integer, sortKey must be created_at or updated_at, and sortDirection must be asc or desc."
      }]
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-wait",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_wait",
          namespace: "twinny",
          tool: "wait_for_threads",
          arguments: { timeout_ms: -1 }
        }
      }
    );

    expect(onDynamicToolCall).not.toHaveBeenCalled();
    expect(protocol.respondMock).toHaveBeenCalledWith("req-wait", {
      success: false,
      contentItems: [{
        type: "inputText",
        text: "Invalid wait_for_threads arguments: thread_ids must be a non-empty string array and timeout_ms must be 0..3600000."
      }]
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-wait-zero",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_wait_zero",
          namespace: "twinny",
          tool: "wait_for_threads",
          arguments: { thread_ids: ["thread_target"], timeout_ms: 0 }
        }
      }
    );

    expect(onDynamicToolCall).toHaveBeenCalledWith({
      requestId: "req-wait-zero",
      threadId: "thread_123",
      turnId: "turn_1",
      callId: "call_wait_zero",
      tool: "wait_for_threads",
      targetThreadIds: ["thread_target"],
      timeoutMs: 0,
      rawArguments: { thread_ids: ["thread_target"], timeout_ms: 0 }
    });
    onDynamicToolCall.mockClear();

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-tell",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_tell",
          namespace: "twinny",
          tool: "tell_thread",
          arguments: { thread_id: "thread_target", msg: "   " }
        }
      }
    );

    expect(onDynamicToolCall).not.toHaveBeenCalled();
    expect(protocol.respondMock).toHaveBeenCalledWith("req-tell", {
      success: false,
      contentItems: [{
        type: "inputText",
        text: "Invalid tell_thread arguments: thread_id and msg are required."
      }]
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-tell-mode",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_tell_mode",
          namespace: "twinny",
          tool: "tell_thread",
          arguments: { thread_id: "thread_target", msg: "hello", mode: "later" }
        }
      }
    );

    expect(onDynamicToolCall).not.toHaveBeenCalled();
    expect(protocol.respondMock).toHaveBeenCalledWith("req-tell-mode", {
      success: false,
      contentItems: [{
        type: "inputText",
        text: "Invalid tell_thread arguments: mode must be queue, steer, or interrupt."
      }]
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-add-cron",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_add_cron",
          namespace: "twinny",
          tool: "add_cron",
          arguments: { cron_exp: "*/5 * * * *", msg: "   " }
        }
      }
    );

    expect(onDynamicToolCall).not.toHaveBeenCalled();
    expect(protocol.respondMock).toHaveBeenCalledWith("req-add-cron", {
      success: false,
      contentItems: [{
        type: "inputText",
        text: "Invalid add_cron arguments: cron_exp and msg are required."
      }]
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-del-cron",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_del_cron",
          namespace: "twinny",
          tool: "del_cron",
          arguments: { cron_id: 0 }
        }
      }
    );

    expect(onDynamicToolCall).not.toHaveBeenCalled();
    expect(protocol.respondMock).toHaveBeenCalledWith("req-del-cron", {
      success: false,
      contentItems: [{
        type: "inputText",
        text: "Invalid del_cron arguments: cron_id must be an integer >= 1."
      }]
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-watch-lark-url",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_watch",
          namespace: "twinny",
          tool: "watch_lark_url",
          arguments: { url: "https://example.feishu.cn/docx/doc_token", mode: "none" }
        }
      }
    );

    expect(onDynamicToolCall).not.toHaveBeenCalled();
    expect(protocol.respondMock).toHaveBeenCalledWith("req-watch-lark-url", {
      success: false,
      contentItems: [{
        type: "inputText",
        text: "Invalid watch_lark_url arguments: mode must be owner_at, owner, all_at, or all."
      }]
    });

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onDynamicToolCall
      },
      {
        id: "req-rm-lark-watchers",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_rm_watchers",
          namespace: "twinny",
          tool: "rm_lark_url_watchers",
          arguments: { watcher_id: 1, url: "https://example.feishu.cn/docx/doc_token" }
        }
      }
    );

    expect(onDynamicToolCall).not.toHaveBeenCalled();
    expect(protocol.respondMock).toHaveBeenCalledWith("req-rm-lark-watchers", {
      success: false,
      contentItems: [{
        type: "inputText",
        text: "Invalid rm_lark_url_watchers arguments: provide exactly one of watcher_id or url."
      }]
    });
  });

  it("rejects unsupported dynamic tools for the active thread", () => {
    const protocol = new FakeProtocol();

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1"
      },
      {
        id: "req-3",
        method: "item/tool/call",
        params: {
          threadId: "thread_123",
          turnId: "turn_1",
          callId: "call_3",
          namespace: "other",
          tool: "set_thread_name",
          arguments: { name: "Title" }
        }
      }
    );

    expect(protocol.respondErrorMock).toHaveBeenCalledWith("req-3", {
      code: "TWINNY_UNSUPPORTED_SERVER_REQUEST",
      message: "Twinny does not implement dynamic tool other.set_thread_name"
    });
  });

  it("ignores dynamic tool calls for a different thread", () => {
    const protocol = new FakeProtocol();

    handleTurnServerRequest(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1"
      },
      {
        id: "req-4",
        method: "item/tool/call",
        params: {
          threadId: "thread_other",
          turnId: "turn_1",
          callId: "call_4",
          namespace: "twinny",
          tool: "set_thread_name",
          arguments: { name: "Title" }
        }
      }
    );

    expect(protocol.respondMock).not.toHaveBeenCalled();
    expect(protocol.respondErrorMock).not.toHaveBeenCalled();
  });
});

describe("TurnOutputAccumulator", () => {
  it("aggregates assistant text from item/completed and turn/completed notifications", async () => {
    const accumulator = new TurnOutputAccumulator("thread_123");

    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "turn_1" }
      }
    });
    accumulator.record({
      method: "item/completed",
      params: {
        threadId: "thread_123",
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "first" }
      }
    });
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "turn_1",
          status: "completed",
          durationMs: 42,
          items: [
            { type: "agentMessage", id: "msg_1", text: "first" },
            { type: "agentMessage", id: "msg_2", text: "second" }
          ]
        }
      }
    });

    await expect(accumulator.wait()).resolves.toEqual({
      threadId: "thread_123",
      turnId: "turn_1",
      text: "first\n\nsecond",
      status: "completed",
      error: undefined,
      durationMs: 42
    });
  });

  it("emits completed agentMessage items without replaying turn/completed items", async () => {
    const messages: Array<{ id: string; text: string }> = [];
    const accumulator = new TurnOutputAccumulator("thread_123", undefined, {
      onAgentMessage: (message) => {
        messages.push(message);
      }
    });

    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "turn_1" }
      }
    });
    accumulator.record({
      method: "item/completed",
      params: {
        threadId: "thread_123",
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "first" }
      }
    });
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "turn_1",
          status: "completed",
          items: [
            { type: "agentMessage", id: "msg_1", text: "first" },
            { type: "agentMessage", id: "msg_2", text: "finish-only" }
          ]
        }
      }
    });

    await accumulator.wait();

    expect(messages).toEqual([{ id: "msg_1", text: "first" }]);
  });

  it("collects imageGeneration items and emits item/completed callbacks", async () => {
    const images: Array<{ id: string; savedPath?: string; status?: string }> = [];
    const accumulator = new TurnOutputAccumulator("thread_123", undefined, {
      onImageGeneration: (image) => {
        images.push(image);
      }
    });

    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "turn_1" }
      }
    });
    accumulator.record({
      method: "item/completed",
      params: {
        threadId: "thread_123",
        turnId: "turn_1",
        item: {
          type: "imageGeneration",
          id: "ig_1",
          status: "completed",
          savedPath: "/tmp/generated.png",
          revisedPrompt: "make an image"
        }
      }
    });
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "turn_1",
          status: "completed",
          durationMs: 7,
          items: [
            {
              type: "imageGeneration",
              id: "ig_1",
              status: "completed",
              savedPath: "/tmp/generated.png",
              revisedPrompt: "make an image"
            }
          ]
        }
      }
    });

    await expect(accumulator.wait()).resolves.toMatchObject({
      threadId: "thread_123",
      turnId: "turn_1",
      text: "",
      status: "completed",
      generatedImages: [
        {
          id: "ig_1",
          status: "completed",
          savedPath: "/tmp/generated.png",
          revisedPrompt: "make an image"
        }
      ]
    });
    expect(images).toEqual([{ id: "ig_1", status: "completed", savedPath: "/tmp/generated.png", revisedPrompt: "make an image" }]);
  });

  it("preserves agentMessage phase and prefers final answer text in turn results", async () => {
    const messages: Array<{ id: string; text: string; phase?: "commentary" | "final_answer" | null }> = [];
    const accumulator = new TurnOutputAccumulator("thread_123", undefined, {
      onAgentMessage: (message) => {
        messages.push(message);
      }
    });

    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "turn_1" }
      }
    });
    accumulator.record({
      method: "item/completed",
      params: {
        threadId: "thread_123",
        turnId: "turn_1",
        item: { type: "agentMessage", id: "msg_1", text: "working", phase: "commentary" }
      }
    });
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "turn_1",
          status: "completed",
          items: [
            { type: "agentMessage", id: "msg_1", text: "working", phase: "commentary" },
            { type: "agentMessage", id: "msg_2", text: "final result", phase: "final_answer" }
          ]
        }
      }
    });

    await expect(accumulator.wait()).resolves.toMatchObject({
      threadId: "thread_123",
      turnId: "turn_1",
      text: "final result",
      status: "completed"
    });
    expect(messages).toEqual([{ id: "msg_1", text: "working", phase: "commentary" }]);
  });

  it("reports interrupted turn status and emits turn-started once", async () => {
    const turnStarted = vi.fn();
    const accumulator = new TurnOutputAccumulator("thread_123", undefined, {
      onTurnStarted: turnStarted
    });

    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "turn_1" }
      }
    });
    accumulator.setTurnId("turn_1");
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "turn_1",
          status: "interrupted",
          items: []
        }
      }
    });

    await expect(accumulator.wait()).resolves.toMatchObject({
      threadId: "thread_123",
      turnId: "turn_1",
      status: "interrupted"
    });
    expect(turnStarted).toHaveBeenCalledTimes(1);
    expect(turnStarted).toHaveBeenCalledWith("turn_1");
  });

  it("keeps the turn/start response id when notifications report another turn", async () => {
    const turnStarted = vi.fn();
    const messages: Array<{ id: string; text: string }> = [];
    const accumulator = new TurnOutputAccumulator("thread_123", undefined, {
      onTurnStarted: turnStarted,
      onAgentMessage: (message) => {
        messages.push(message);
      }
    });

    accumulator.setTurnId("response_turn", "response");
    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "notification_turn" }
      }
    });
    accumulator.record({
      method: "item/completed",
      params: {
        threadId: "thread_123",
        turnId: "notification_turn",
        item: { type: "agentMessage", id: "msg_1", text: "stale progress" }
      }
    });
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "notification_turn",
          status: "interrupted",
          items: [{ type: "agentMessage", id: "msg_1", text: "stale progress" }]
        }
      }
    });
    accumulator.record({
      method: "item/completed",
      params: {
        threadId: "thread_123",
        turnId: "response_turn",
        item: { type: "agentMessage", id: "msg_2", text: "current progress" }
      }
    });
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "response_turn",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg_2", text: "current progress" }]
        }
      }
    });

    await expect(accumulator.wait()).resolves.toMatchObject({
      threadId: "thread_123",
      turnId: "response_turn",
      text: "current progress",
      status: "completed"
    });
    expect(messages).toEqual([{ id: "msg_2", text: "current progress" }]);
    expect(turnStarted).toHaveBeenCalledTimes(1);
    expect(turnStarted).toHaveBeenCalledWith("response_turn");
  });

  it("keeps waiting when Codex reports a retryable turn error", async () => {
    const codexError = vi.fn();
    const accumulator = new TurnOutputAccumulator("thread_123", undefined, { onCodexError: codexError });

    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "turn_1" }
      }
    });
    accumulator.record({
      method: "error",
      params: {
        message: "Reconnecting... 2/5",
        willRetry: true,
        error: {
          codexErrorInfo: {
            responseStreamDisconnected: {
              httpStatusCode: null
            }
          }
        },
        additionalDetails: "stream disconnected before completion"
      }
    });
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "turn_1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg_1", text: "done after reconnect" }]
        }
      }
    });

    await expect(accumulator.wait()).resolves.toMatchObject({
      threadId: "thread_123",
      turnId: "turn_1",
      text: "done after reconnect",
      status: "completed"
    });
    expect(codexError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Reconnecting... 2/5",
      willRetry: true,
      codexErrorInfo: "responseStreamDisconnected",
      additionalDetails: "stream disconnected before completion"
    }));
  });

  it("ignores Codex errors from another thread", async () => {
    const accumulator = new TurnOutputAccumulator("thread_123");

    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "turn_1" }
      }
    });
    accumulator.record({
      method: "error",
      params: {
        threadId: "thread_other",
        turnId: "turn_other",
        message: "other thread failed",
        willRetry: false
      }
    });
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "turn_1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg_1", text: "done" }]
        }
      }
    });

    await expect(accumulator.wait()).resolves.toMatchObject({
      threadId: "thread_123",
      turnId: "turn_1",
      text: "done",
      status: "completed"
    });
  });

  it("ignores Codex errors from another turn once the current turn is known", async () => {
    const accumulator = new TurnOutputAccumulator("thread_123");

    accumulator.record({
      method: "turn/started",
      params: {
        threadId: "thread_123",
        turn: { id: "turn_1" }
      }
    });
    accumulator.record({
      method: "error",
      params: {
        threadId: "thread_123",
        turnId: "turn_2",
        message: "other turn failed",
        willRetry: false
      }
    });
    accumulator.record({
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "turn_1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg_1", text: "done" }]
        }
      }
    });

    await expect(accumulator.wait()).resolves.toMatchObject({
      threadId: "thread_123",
      turnId: "turn_1",
      text: "done",
      status: "completed"
    });
  });

  it("fails when Codex reports a non-retryable turn error", async () => {
    const accumulator = new TurnOutputAccumulator("thread_123");

    accumulator.record({
      method: "error",
      params: {
        error: { message: "stream disconnected before completion" },
        willRetry: false
      }
    });

    await expect(accumulator.wait()).rejects.toMatchObject({
      code: "CODEX_TURN_FAILED",
      message: "stream disconnected before completion"
    });
  });

  it("emits thread token usage updates", async () => {
    const tokenUsage = vi.fn();
    const accumulator = new TurnOutputAccumulator("thread_123", undefined, {
      onTokenUsage: tokenUsage
    });

    accumulator.record({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread_123",
        turnId: "turn_1",
        usage: {
          total: {
            totalTokens: 99
          }
        }
      }
    });

    expect(tokenUsage).toHaveBeenCalledWith({
      threadId: "thread_123",
      turnId: "turn_1",
      totalTokens: 99,
      raw: {
        threadId: "thread_123",
        turnId: "turn_1",
        usage: {
          total: {
            totalTokens: 99
          }
        }
      }
    });
  });

  it("emits plan updates from completed plan items", () => {
    const planUpdated = vi.fn();
    const turnStarted = vi.fn();
    const accumulator = new TurnOutputAccumulator("thread_123", undefined, {
      onPlanUpdated: planUpdated,
      onTurnStarted: turnStarted
    });

    accumulator.record({
      method: "item/completed",
      params: {
        threadId: "thread_123",
        turnId: "turn_1",
        item: {
          type: "plan",
          id: "plan_1",
          text: "# Plan\n\n- Step one\n- Step two"
        }
      }
    });

    expect(turnStarted).toHaveBeenCalledWith("turn_1");
    expect(planUpdated).toHaveBeenCalledWith({
      threadId: "thread_123",
      turnId: "turn_1",
      explanation: "# Plan\n\n- Step one\n- Step two",
      plan: []
    });
  });
});

describe("startCodexTurn", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses request timeout for turn/start without timing out normal long-running turns", async () => {
    vi.useFakeTimers();
    const protocol = new FakeProtocol();
    protocol.requestMock.mockImplementationOnce(async () => {
      setTimeout(() => {
        protocol.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread_123",
            turn: {
              id: "turn_1",
              status: "completed",
              items: [{ type: "agentMessage", id: "msg_1", text: "done" }]
            }
          }
        });
      }, 10);
      return { turn: { id: "turn_1" } };
    });

    const result = startCodexTurn(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "work longer than the request timeout",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1"
      },
      { requestTimeoutMs: 5 }
    );

    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toMatchObject({
      threadId: "thread_123",
      turnId: "turn_1",
      text: "done",
      status: "completed"
    });
    expect(protocol.requestMock).toHaveBeenCalledWith(
      "turn/start",
      expect.any(Object),
      { timeoutMs: 5 }
    );
  });

  it("ignores stale notifications received before turn/start returns the active turn id", async () => {
    const protocol = new FakeProtocol();
    const turnStarted = vi.fn();
    const agentMessages = vi.fn();
    const tokenUsage = vi.fn();

    protocol.requestMock.mockImplementationOnce(async () => {
      protocol.emit("notification", {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread_123",
          turnId: "stale_turn",
          usage: {
            total: {
              totalTokens: 11
            }
          }
        }
      });
      protocol.emit("notification", {
        method: "item/completed",
        params: {
          threadId: "thread_123",
          turnId: "stale_turn",
          item: { type: "agentMessage", id: "msg_stale", text: "stale output" }
        }
      });
      protocol.emit("notification", {
        method: "turn/completed",
        params: {
          threadId: "thread_123",
          turn: {
            id: "stale_turn",
            status: "interrupted",
            items: [{ type: "agentMessage", id: "msg_stale", text: "stale output" }]
          }
        }
      });
      return { turn: { id: "active_turn" } };
    });

    const result = startCodexTurn(
      protocol as unknown as CodexProtocolClient,
      {
        threadId: "thread_123",
        text: "continue",
        cwd: "/tmp/twinny/workspaces/p2p_ou_1",
        onTurnStarted: turnStarted,
        onAgentMessage: agentMessages,
        onTokenUsage: tokenUsage
      }
    );

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    protocol.emit("notification", {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread_123",
        turnId: "active_turn",
        usage: {
          total: {
            totalTokens: 99
          }
        }
      }
    });
    protocol.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread_123",
        turnId: "active_turn",
        item: { type: "agentMessage", id: "msg_active", text: "current output" }
      }
    });
    protocol.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "thread_123",
        turn: {
          id: "active_turn",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg_active", text: "current output" }]
        }
      }
    });

    await expect(result).resolves.toMatchObject({
      threadId: "thread_123",
      turnId: "active_turn",
      text: "current output",
      status: "completed"
    });
    expect(turnStarted).toHaveBeenCalledTimes(1);
    expect(turnStarted).toHaveBeenCalledWith("active_turn");
    expect(agentMessages).toHaveBeenCalledTimes(1);
    expect(agentMessages).toHaveBeenCalledWith({ id: "msg_active", text: "current output" });
    expect(tokenUsage).toHaveBeenCalledTimes(1);
    expect(tokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread_123",
        turnId: "active_turn",
        totalTokens: 99
      })
    );
  });
});

class FakeProtocol extends EventEmitter {
  readonly requestMock = vi.fn();
  readonly respondMock = vi.fn();
  readonly respondErrorMock = vi.fn();

  request<TResult = unknown>(...args: unknown[]): Promise<TResult> {
    return this.requestMock(...args) as Promise<TResult>;
  }

  respond(...args: unknown[]): void {
    this.respondMock(...args);
  }

  respondError(...args: unknown[]): void {
    this.respondErrorMock(...args);
  }
}
