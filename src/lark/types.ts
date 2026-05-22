import type {
  IncomingLarkBotMenuAction,
  IncomingLarkCardAction,
  IncomingLarkMessage,
  IncomingLarkMessageRecall,
  LarkReactionHandle
} from "../types.js";

export const LARK_BOT_MENU_EVENT = "application.bot.menu_v6" as const;
export const LARK_MESSAGE_RECEIVE_EVENT = "im.message.receive_v1" as const;
export const LARK_MESSAGE_RECALLED_EVENT = "im.message.recalled_v1" as const;
export const LARK_CARD_ACTION_TRIGGER_EVENT = "card.action.trigger" as const;

export const LARK_REQUIRED_SCOPES = [
  "im:message.p2p_msg:readonly",
  "im:message.group_msg",
  "im:message:readonly",
  "im:message:send_as_bot",
  "im:message:update",
  "im:message:recall",
  "im:message.reactions:write_only",
  "im:chat:read",
  "im:chat:create",
  "im:chat:update",
  "im:resource"
] as const;

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers?: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
  text?(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export interface FetchRequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData;
  signal?: AbortSignal;
}

export type FetchLike = (input: string, init?: FetchRequestInitLike) => Promise<FetchResponseLike>;

export interface LarkCredentialOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
}

export interface LarkLogger {
  debug?: (metadata: Record<string, unknown>, message?: string) => void;
  info?: (metadata: Record<string, unknown>, message?: string) => void;
  warn?: (metadata: Record<string, unknown>, message?: string) => void;
  error?: (metadata: Record<string, unknown>, message?: string) => void;
}

export interface LarkSdkLogger {
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface LarkSendMessageResult {
  messageId?: string;
  raw: unknown;
}

export type {
  IncomingLarkBotMenuAction,
  IncomingLarkCardAction,
  IncomingLarkMessage,
  IncomingLarkMessageRecall,
  LarkReactionHandle
};
