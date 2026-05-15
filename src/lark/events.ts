import * as Lark from "@larksuiteoapi/node-sdk";
import { DEFAULT_LARK_MAX_MESSAGE_AGE_SECONDS } from "../types.js";
import { TenantAccessTokenManager } from "./auth.js";
import { normalizeIncomingLarkMessageWithReason } from "./filters.js";
import { LARK_MESSAGE_RECEIVE_EVENT, type IncomingLarkMessage, type LarkLogger } from "./types.js";

export interface EventDispatcherLike {
  register(handles: Record<string, (data: unknown) => unknown>): EventDispatcherLike;
}

export interface WsClientLike {
  start(params: { eventDispatcher: EventDispatcherLike }): Promise<void> | void;
  close(params?: { force?: boolean }): Promise<void> | void;
  getConnectionStatus?(): unknown;
}

export interface LarkEventConsumerOptions {
  appId: string;
  appSecret: string;
  botOpenId?: string;
  tokenManager?: TenantAccessTokenManager;
  logger?: LarkLogger;
  domain?: string | Lark.Domain;
  autoReconnect?: boolean;
  warmTenantToken?: boolean;
  maxMessageAgeMs?: number;
  now?: () => number;
  onMessage: (message: IncomingLarkMessage) => Promise<void> | void;
  onIgnored?: (reason: string, raw: unknown) => void;
  wsClientFactory?: (options: LarkEventConsumerWsFactoryOptions) => WsClientLike;
  eventDispatcherFactory?: () => EventDispatcherLike;
}

export interface LarkEventConsumerWsFactoryOptions {
  appId: string;
  appSecret: string;
  domain?: string | Lark.Domain;
  autoReconnect?: boolean;
  onReady: () => void;
  onError: (error: Error) => void;
  onReconnecting: () => void;
  onReconnected: () => void;
}

export class LarkEventConsumer {
  private readonly options: LarkEventConsumerOptions;
  private wsClient?: WsClientLike;
  private dispatcher?: EventDispatcherLike;
  private running = false;
  private ready = false;

  constructor(options: LarkEventConsumerOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isReady(): boolean {
    return this.ready;
  }

  getConnectionStatus(): unknown {
    return this.wsClient?.getConnectionStatus?.();
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    if (this.options.warmTenantToken ?? true) {
      const tokenManager =
        this.options.tokenManager ??
        new TenantAccessTokenManager({
          appId: this.options.appId,
          appSecret: this.options.appSecret
        });
      await tokenManager.getTenantAccessToken();
    }

    this.dispatcher = (this.options.eventDispatcherFactory ?? createDefaultEventDispatcher)().register({
      [LARK_MESSAGE_RECEIVE_EVENT]: async (data: unknown) => {
        const result = normalizeIncomingLarkMessageWithReason(data, {
          botOpenId: this.options.botOpenId
        });
        if (result.kind === "ignored") {
          this.options.onIgnored?.(result.reason, result.raw);
          this.options.logger?.debug?.({ reason: result.reason }, "ignored Lark message event");
          return;
        }
        if (this.isStaleMessage(result.message)) {
          this.options.onIgnored?.("stale_message", result.message.raw);
          return;
        }
        await this.options.onMessage(result.message);
      }
    });

    this.wsClient = (this.options.wsClientFactory ?? createDefaultWsClient)({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      domain: this.options.domain,
      autoReconnect: this.options.autoReconnect,
      onReady: () => {
        this.ready = true;
        this.options.logger?.info?.({}, "Lark event long connection is ready");
      },
      onError: (error) => {
        this.ready = false;
        this.options.logger?.error?.({ error: error.message }, "Lark event long connection failed");
      },
      onReconnecting: () => {
        this.ready = false;
        this.options.logger?.warn?.({}, "Lark event long connection is reconnecting");
      },
      onReconnected: () => {
        this.ready = true;
        this.options.logger?.info?.({}, "Lark event long connection reconnected");
      }
    });

    this.running = true;
    await this.wsClient.start({ eventDispatcher: this.dispatcher });
  }

  async stop(options: { force?: boolean } = {}): Promise<void> {
    const wsClient = this.wsClient;
    this.wsClient = undefined;
    this.dispatcher = undefined;
    this.ready = false;
    this.running = false;
    await wsClient?.close({ force: options.force ?? false });
  }

  private isStaleMessage(message: IncomingLarkMessage): boolean {
    if (message.createTime === undefined) {
      return false;
    }
    const maxAgeMs = this.options.maxMessageAgeMs ?? DEFAULT_LARK_MAX_MESSAGE_AGE_SECONDS * 1000;
    const now = this.options.now?.() ?? Date.now();
    const ageMs = now - message.createTime;
    if (ageMs <= maxAgeMs) {
      return false;
    }
    const metadata: Record<string, unknown> = {
      messageId: message.messageId,
      chatId: message.chatId,
      senderOpenId: message.senderOpenId,
      createTime: message.createTime,
      ageMs,
      maxAgeMs
    };
    this.options.logger?.warn?.(metadata, "dropped stale Lark message event");
    return true;
  }
}

function createDefaultEventDispatcher(): EventDispatcherLike {
  return new Lark.EventDispatcher({});
}

function createDefaultWsClient(options: LarkEventConsumerWsFactoryOptions): WsClientLike {
  return new Lark.WSClient({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: options.domain,
    autoReconnect: options.autoReconnect,
    source: "twinny",
    onReady: options.onReady,
    onError: options.onError,
    onReconnecting: options.onReconnecting,
    onReconnected: options.onReconnected
  }) as WsClientLike;
}
