import type { IncomingLarkMessage, LarkReactionHandle } from "../types.js";

export const LARK_MESSAGE_RECEIVE_EVENT = "im.message.receive_v1" as const;

export const LARK_REQUIRED_SCOPES = [
  "im:message.p2p_msg:readonly",
  "im:message:readonly",
  "im:message.reactions:write_only"
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
  body?: string;
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

export interface LarkSendMessageResult {
  messageId?: string;
  raw: unknown;
}

export type { IncomingLarkMessage, LarkReactionHandle };
