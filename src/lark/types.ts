import type {
  IncomingLarkBotMenuAction,
  IncomingLarkBotAddedToChat,
  IncomingLarkCardAction,
  IncomingLarkMessage,
  IncomingLarkDocCommentAdd,
  IncomingLarkMessageRecall,
  IncomingLarkP2pChatCreate,
  LarkReactionHandle
} from "../types.js";

export const LARK_BOT_MENU_EVENT = "application.bot.menu_v6" as const;
export const LARK_P2P_CHAT_CREATE_EVENT = "p2p_chat_create" as const;
export const LARK_BOT_ADDED_TO_CHAT_EVENT = "im.chat.member.bot.added_v1" as const;
export const LARK_MESSAGE_RECEIVE_EVENT = "im.message.receive_v1" as const;
export const LARK_MESSAGE_RECALLED_EVENT = "im.message.recalled_v1" as const;
export const LARK_CARD_ACTION_TRIGGER_EVENT = "card.action.trigger" as const;
export const LARK_DOC_COMMENT_ADD_EVENT = "drive.notice.comment_add_v1" as const;
export const LARK_GROUP_MENTION_SCOPE = "im:message.group_at_msg:readonly" as const;
export const LARK_GROUP_ALL_MESSAGES_SCOPE = "im:message.group_msg" as const;
export const LARK_CONTACT_USER_BASE_SCOPE = "contact:user.base:readonly" as const;

export const LARK_REQUIRED_SCOPES = [
  "im:message.p2p_msg:readonly",
  LARK_GROUP_MENTION_SCOPE,
  "im:message:readonly",
  "im:message:send_as_bot",
  "im:message:update",
  "im:message:recall",
  "im:message.reactions:write_only",
  "im:chat:read",
  "im:chat:create",
  "im:chat:update",
  "im:resource",
  LARK_CONTACT_USER_BASE_SCOPE,
  "docs:document.comment:read",
  "docs:document.comment:create",
  "docs:document.comment:write_only",
  "docs:document.media:download",
  "wiki:node:read"
] as const;

export const LARK_OPTIONAL_SCOPES = [
  LARK_GROUP_ALL_MESSAGES_SCOPE
] as const;

export const LARK_REQUIRED_SCOPE_ALTERNATIVES: Readonly<Record<string, readonly string[]>> = {
  [LARK_GROUP_MENTION_SCOPE]: [
    "im:message.group_at_msg",
    "im:message.group_at_msg.include_bot:readonly",
    LARK_GROUP_ALL_MESSAGES_SCOPE,
    "im:message.group_msg:readonly"
  ],
  [LARK_CONTACT_USER_BASE_SCOPE]: [
    "contact:contact.base:readonly"
  ]
};

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

export interface LarkCardActionCallbackResponse {
  toast?: {
    type: "info" | "success" | "error" | "warning";
    content: string;
    i18n?: Record<string, string>;
  };
}

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
  IncomingLarkBotAddedToChat,
  IncomingLarkCardAction,
  IncomingLarkMessage,
  IncomingLarkDocCommentAdd,
  IncomingLarkMessageRecall,
  IncomingLarkP2pChatCreate,
  LarkReactionHandle
};
