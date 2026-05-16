import { describe, expect, it, vi } from "vitest";
import { LarkEventConsumer, type EventDispatcherLike, type WsClientLike } from "./events.js";

describe("LarkEventConsumer", () => {
  it("registers im.message.receive_v1 and forwards normalized messages", async () => {
    const registered: Record<string, (data: unknown) => unknown> = {};
    const dispatcher: EventDispatcherLike = {
      register(handles) {
        Object.assign(registered, handles);
        return this;
      }
    };
    const wsClient: WsClientLike = {
      start: vi.fn(({ eventDispatcher }) => {
        expect(eventDispatcher).toBe(dispatcher);
      }),
      close: vi.fn()
    };
    const onMessage = vi.fn();
    const onIgnored = vi.fn();
    const consumer = new LarkEventConsumer({
      appId: "cli_1234567890abcdef",
      appSecret: "secret",
      warmTenantToken: false,
      onMessage,
      onIgnored,
      eventDispatcherFactory: () => dispatcher,
      wsClientFactory: () => wsClient
    });

    await consumer.start();
    await registered["im.message.receive_v1"](receiveEvent());
    await registered["im.message.receive_v1"](receiveEvent({ message: { chat_id: "oc_group", chat_type: "group" } }));
    await registered["im.message.receive_v1"](receiveEvent({ message: { chat_type: "unsupported" } }));

    expect(Object.keys(registered).sort()).toEqual([
      "im.message.recalled_v1",
      "im.message.receive_v1",
      "im.message.updated_v1"
    ]);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "hello", chatId: "ou_user" }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "hello", chatId: "oc_group", chatType: "group" }));
    expect(onIgnored).toHaveBeenCalledWith("unsupported_chat_type", expect.anything());
    expect(consumer.isRunning).toBe(true);

    await consumer.stop({ force: true });
    expect(wsClient.close).toHaveBeenCalledWith({ force: true });
    expect(consumer.isRunning).toBe(false);
  });

  it("forwards normalized message edit and recall events", async () => {
    const registered: Record<string, (data: unknown) => unknown> = {};
    const dispatcher: EventDispatcherLike = {
      register(handles) {
        Object.assign(registered, handles);
        return this;
      }
    };
    const wsClient: WsClientLike = {
      start: vi.fn(),
      close: vi.fn()
    };
    const onMessageEdit = vi.fn();
    const onMessageRecall = vi.fn();
    const consumer = new LarkEventConsumer({
      appId: "cli_1234567890abcdef",
      appSecret: "secret",
      warmTenantToken: false,
      onMessage: vi.fn(),
      onMessageEdit,
      onMessageRecall,
      eventDispatcherFactory: () => dispatcher,
      wsClientFactory: () => wsClient
    });

    await consumer.start();
    await registered["im.message.updated_v1"]({
      header: { event_id: "event-edit" },
      event: {
        message: {
          message_id: "om_1",
          message_type: "text",
          content: JSON.stringify({ text: "edited" })
        }
      }
    });
    await registered["im.message.recalled_v1"]({
      header: { event_id: "event-recall" },
      event: {
        message_id: "om_1",
        chat_id: "oc_1",
        recall_time: "1234"
      }
    });

    expect(onMessageEdit).toHaveBeenCalledWith(expect.objectContaining({ messageId: "om_1", text: "edited" }));
    expect(onMessageRecall).toHaveBeenCalledWith(expect.objectContaining({ messageId: "om_1", recallTime: 1234 }));
  });

  it("propagates onMessage errors so the websocket layer can respond with failure", async () => {
    const registered: Record<string, (data: unknown) => unknown> = {};
    const dispatcher: EventDispatcherLike = {
      register(handles) {
        Object.assign(registered, handles);
        return this;
      }
    };
    const wsClient: WsClientLike = {
      start: vi.fn(),
      close: vi.fn()
    };
    const consumer = new LarkEventConsumer({
      appId: "cli_1234567890abcdef",
      appSecret: "secret",
      warmTenantToken: false,
      onMessage: () => {
        throw new Error("submit rejected");
      },
      eventDispatcherFactory: () => dispatcher,
      wsClientFactory: () => wsClient
    });

    await consumer.start();

    await expect(registered["im.message.receive_v1"](receiveEvent())).rejects.toThrow("submit rejected");
  });

  it("drops messages older than the configured age and logs them", async () => {
    const registered: Record<string, (data: unknown) => unknown> = {};
    const dispatcher: EventDispatcherLike = {
      register(handles) {
        Object.assign(registered, handles);
        return this;
      }
    };
    const wsClient: WsClientLike = {
      start: vi.fn(),
      close: vi.fn()
    };
    const logger = { warn: vi.fn() };
    const onMessage = vi.fn();
    const onIgnored = vi.fn();
    const consumer = new LarkEventConsumer({
      appId: "cli_1234567890abcdef",
      appSecret: "secret",
      warmTenantToken: false,
      maxMessageAgeMs: 60_000,
      now: () => 120_000,
      logger,
      onMessage,
      onIgnored,
      eventDispatcherFactory: () => dispatcher,
      wsClientFactory: () => wsClient
    });

    await consumer.start();
    await registered["im.message.receive_v1"](receiveEvent({ message: { create_time: "59000" } }));
    await registered["im.message.receive_v1"](receiveEvent({ message: { create_time: "60000" } }));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: "om_1", createTime: 60000 }));
    expect(onIgnored).toHaveBeenCalledWith("stale_message", expect.anything());
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "om_1",
        ageMs: 61_000,
        maxAgeMs: 60_000
      }),
      "dropped stale Lark message event"
    );
  });
});

function receiveEvent(overrides: { sender?: Record<string, unknown>; message?: Record<string, unknown> } = {}) {
  return {
    event_id: "event-1",
    sender: {
      sender_id: {
        open_id: "ou_user"
      },
      sender_type: "user",
      ...overrides.sender
    },
    message: {
      message_id: "om_1",
      create_time: String(Date.now()),
      chat_id: "oc_raw",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      ...overrides.message
    }
  };
}
