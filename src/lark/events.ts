import * as Lark from "@larksuiteoapi/node-sdk";
import { DEFAULT_LARK_MAX_MESSAGE_AGE_SECONDS, type LarkBrand } from "../types.js";
import { TenantAccessTokenManager } from "./auth.js";
import {
  normalizeLarkBotMenuWithReason,
  normalizeIncomingLarkMessageWithReason,
  normalizeLarkMessageRecallWithReason
} from "./filters.js";
import {
  LARK_BOT_MENU_EVENT,
  LARK_CARD_ACTION_TRIGGER_EVENT,
  LARK_MESSAGE_RECEIVE_EVENT,
  LARK_MESSAGE_RECALLED_EVENT,
  type IncomingLarkBotMenuAction,
  type IncomingLarkCardAction,
  type IncomingLarkMessage,
  type IncomingLarkMessageRecall,
  type LarkLogger,
  type LarkSdkLogger
} from "./types.js";

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
  sdkLogger?: LarkSdkLogger;
  domain?: string | Lark.Domain;
  autoReconnect?: boolean;
  warmTenantToken?: boolean;
  maxMessageAgeMs?: number;
  now?: () => number;
  onMessage: (message: IncomingLarkMessage) => Promise<void> | void;
  onMessageRecall?: (recall: IncomingLarkMessageRecall) => Promise<void> | void;
  onBotMenu?: (action: IncomingLarkBotMenuAction) => Promise<void> | void;
  onCardAction?: (action: IncomingLarkCardAction) => Promise<void> | void;
  onConnectionError?: (error: Error) => void;
  onIgnored?: (reason: string, raw: unknown) => void;
  wsClientFactory?: (options: LarkEventConsumerWsFactoryOptions) => WsClientLike;
  eventDispatcherFactory?: () => EventDispatcherLike;
}

export interface LarkEventConsumerWsFactoryOptions {
  appId: string;
  appSecret: string;
  domain?: string | Lark.Domain;
  autoReconnect?: boolean;
  sdkLogger?: LarkSdkLogger;
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
      },
      [LARK_MESSAGE_RECALLED_EVENT]: async (data: unknown) => {
        if (!this.options.onMessageRecall) {
          return;
        }
        const result = normalizeLarkMessageRecallWithReason(data);
        if (result.kind === "ignored") {
          this.options.onIgnored?.(result.reason, result.raw);
          this.options.logger?.debug?.({ reason: result.reason }, "ignored Lark message recall event");
          return;
        }
        await this.options.onMessageRecall(result.recall);
      },
      [LARK_BOT_MENU_EVENT]: async (data: unknown) => {
        if (!this.options.onBotMenu) {
          return;
        }
        const result = normalizeLarkBotMenuWithReason(data);
        if (result.kind === "ignored") {
          this.options.onIgnored?.(result.reason, result.raw);
          this.options.logger?.debug?.({ reason: result.reason }, "ignored Lark bot menu event");
          return;
        }
        await this.options.onBotMenu(result.action);
      },
      [LARK_CARD_ACTION_TRIGGER_EVENT]: async (data: unknown) => {
        if (!this.options.onCardAction) {
          return;
        }
        const result = normalizeLarkCardActionWithReason(data);
        if (result.kind === "ignored") {
          this.options.onIgnored?.(result.reason, result.raw);
          this.options.logger?.debug?.({ reason: result.reason }, "ignored Lark card action event");
          return;
        }
        await this.options.onCardAction(result.action);
      }
    });

    this.wsClient = (this.options.wsClientFactory ?? createDefaultWsClient)({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      domain: this.options.domain,
      autoReconnect: this.options.autoReconnect,
      sdkLogger: this.options.sdkLogger,
      onReady: () => {
        this.ready = true;
        this.options.logger?.info?.({}, "Lark event long connection is ready");
      },
      onError: (error) => {
        this.ready = false;
        this.options.logger?.error?.({ error: error.message }, "Lark event long connection failed");
        this.options.onConnectionError?.(error);
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

type NormalizeCardActionResult =
  | { kind: "ok"; action: IncomingLarkCardAction }
  | { kind: "ignored"; reason: string; raw: unknown };

function normalizeLarkCardActionWithReason(data: unknown): NormalizeCardActionResult {
  const root = asRecord(data);
  if (!root) {
    return { kind: "ignored", reason: "invalid_card_action_event", raw: data };
  }
  const header = asRecord(root.header);
  const event = asRecord(root.event) ?? root;
  const eventId = stringValue(root.event_id) ?? stringValue(header?.event_id);
  const operator = asRecord(event.operator);
  const operatorOpenId =
    stringValue(operator?.open_id) ??
    stringValue(asRecord(operator?.operator_id)?.open_id) ??
    stringValue(asRecord(operator?.user_id)?.open_id);
  const action = asRecord(event.action);
  const actionValue = asRecord(action?.value);
  const formValue = asRecord(action?.form_value) ?? asRecord(action?.formValue);
  const openMessageId =
    stringValue(event.open_message_id) ??
    stringValue(event.message_id) ??
    stringValue(asRecord(event.context)?.open_message_id) ??
    stringValue(asRecord(event.context)?.message_id);
  const openChatId =
    stringValue(event.open_chat_id) ??
    stringValue(event.chat_id) ??
    stringValue(asRecord(event.context)?.open_chat_id) ??
    stringValue(asRecord(event.context)?.chat_id);

  if (!eventId) {
    return { kind: "ignored", reason: "missing_card_action_event_id", raw: data };
  }
  if (!operatorOpenId) {
    return { kind: "ignored", reason: "missing_card_action_operator", raw: data };
  }
  if (!actionValue) {
    return { kind: "ignored", reason: "missing_card_action_value", raw: data };
  }

  return {
    kind: "ok",
    action: {
      eventId,
      operatorOpenId,
      openMessageId,
      openChatId,
      actionTag: stringValue(action?.tag),
      actionValue,
      formValue,
      raw: data
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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
    ...(options.sdkLogger ? { logger: options.sdkLogger, loggerLevel: Lark.LoggerLevel.trace } : {}),
    onReady: options.onReady,
    onError: options.onError,
    onReconnecting: options.onReconnecting,
    onReconnected: options.onReconnected
  }) as WsClientLike;
}

export function resolveLarkEventDomain(brand: LarkBrand): Lark.Domain {
  return brand === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
}
