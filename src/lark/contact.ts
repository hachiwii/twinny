import { LarkOpenApiClient } from "./openapi.js";
import type { LarkChatMode, LarkGroupMessageType } from "../types.js";

export type LarkDirectoryChatMode = LarkChatMode | "p2p";

export interface LarkUserDirectoryOptions {
  openApiClient: LarkOpenApiClient;
}

export interface LarkChatInfo {
  chatId?: string;
  name?: string;
  chatMode?: LarkDirectoryChatMode;
  groupMessageType?: LarkGroupMessageType;
}

export interface CreateLarkChatInput {
  name: string;
  ownerOpenId?: string;
  userOpenIds?: string[];
  groupMessageType?: LarkGroupMessageType;
  uuid?: string;
  setBotManager?: boolean;
}

export interface LarkChatCreateResult {
  chatId?: string;
  raw: unknown;
}

export interface LarkChatLinkResult {
  link?: string;
  raw: unknown;
}

export class LarkUserDirectory {
  constructor(private readonly options: LarkUserDirectoryOptions) {}

  async getUserNameByOpenId(openId: string): Promise<string | undefined> {
    const raw = await this.options.openApiClient.request(`/contact/v3/users/${encodePathSegment(openId)}`, {
      method: "GET",
      query: {
        user_id_type: "open_id"
      }
    });
    return extractUserName(raw);
  }
}

export class LarkChatDirectory {
  constructor(private readonly options: LarkUserDirectoryOptions) {}

  async createChat(input: CreateLarkChatInput): Promise<LarkChatCreateResult> {
    const raw = await this.options.openApiClient.request("/im/v1/chats", {
      method: "POST",
      query: {
        user_id_type: "open_id",
        ...(input.uuid ? { uuid: input.uuid } : {}),
        ...(input.setBotManager === undefined ? {} : { set_bot_manager: input.setBotManager })
      },
      body: {
        name: input.name,
        chat_type: "private",
        group_message_type: input.groupMessageType ?? "chat",
        ...(input.ownerOpenId ? { owner_id: input.ownerOpenId } : {}),
        ...(input.userOpenIds?.length ? { user_id_list: input.userOpenIds } : {})
      }
    });
    return {
      chatId: extractChatId(raw),
      raw
    };
  }

  async getChatInfo(chatId: string): Promise<LarkChatInfo> {
    const raw = await this.options.openApiClient.request(`/im/v1/chats/${encodePathSegment(chatId)}`, {
      method: "GET",
      query: {
        user_id_type: "open_id"
      }
    });
    return extractChatInfo(raw);
  }

  async getChatName(chatId: string): Promise<string | undefined> {
    return (await this.getChatInfo(chatId)).name;
  }

  async getChatLink(chatId: string): Promise<string | undefined> {
    const raw = await this.options.openApiClient.request(`/im/v1/chats/${encodePathSegment(chatId)}/link`, {
      method: "GET"
    });
    return extractChatLink(raw);
  }
}

export class LarkBotDirectory {
  constructor(private readonly options: LarkUserDirectoryOptions) {}

  async getBotOpenId(): Promise<string | undefined> {
    const raw = await this.options.openApiClient.request("/bot/v3/info", {
      method: "GET"
    });
    return extractBotOpenId(raw);
  }
}

function extractUserName(raw: unknown): string | undefined {
  const data = getRecord(raw, "data");
  const user = getRecord(data, "user");
  return firstNonEmptyString(user.name, user.en_name, user.nickname);
}

function extractChatInfo(raw: unknown): LarkChatInfo {
  const data = getRecord(raw, "data");
  const chat = getRecord(data, "chat");
  return {
    chatId: firstNonEmptyString(chat.chat_id, data.chat_id),
    name: firstNonEmptyString(chat.name, chat.chat_name, chat.title, data.name, data.chat_name, data.title),
    chatMode: normalizeLarkChatMode(firstNonEmptyString(chat.chat_mode, data.chat_mode)),
    groupMessageType: normalizeLarkGroupMessageType(firstNonEmptyString(chat.group_message_type, data.group_message_type))
  };
}

function extractChatId(raw: unknown): string | undefined {
  const data = getRecord(raw, "data");
  const chat = getRecord(data, "chat");
  return firstNonEmptyString(chat.chat_id, data.chat_id);
}

function extractChatLink(raw: unknown): string | undefined {
  const data = getRecord(raw, "data");
  return firstNonEmptyString(data.share_link, data.link, data.url);
}

function normalizeLarkChatMode(value: string | undefined): LarkDirectoryChatMode | undefined {
  if (value === "p2p" || value === "group" || value === "topic") {
    return value;
  }
  return undefined;
}

function normalizeLarkGroupMessageType(value: string | undefined): LarkGroupMessageType | undefined {
  if (value === "chat" || value === "thread") {
    return value;
  }
  return undefined;
}

function extractBotOpenId(raw: unknown): string | undefined {
  const data = getRecord(raw, "data");
  const bot = Object.keys(data).length > 0 ? getRecord(data, "bot") : getRecord(raw, "bot");
  return firstNonEmptyString(bot.open_id, data.open_id);
}

function getRecord(source: unknown, key: string): Record<string, unknown> {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }
  const value = (source as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
