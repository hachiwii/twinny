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
    await registered["im.message.receive_v1"](receiveEvent({ message: { chat_type: "group" } }));

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "hello", chatId: "ou_user" }));
    expect(onIgnored).toHaveBeenCalledWith("non_p2p_message", expect.anything());
    expect(consumer.isRunning).toBe(true);

    await consumer.stop({ force: true });
    expect(wsClient.close).toHaveBeenCalledWith({ force: true });
    expect(consumer.isRunning).toBe(false);
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
      create_time: "1234",
      chat_id: "oc_raw",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      ...overrides.message
    }
  };
}
