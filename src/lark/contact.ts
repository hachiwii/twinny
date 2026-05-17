import { LarkOpenApiClient } from "./openapi.js";
import type { LarkChatMode, LarkGroupMessageType } from "../types.js";

export interface LarkUserDirectoryOptions {
  openApiClient: LarkOpenApiClient;
}

export interface LarkChatInfo {
  chatId?: string;
  name?: string;
  chatMode?: LarkChatMode;
  groupMessageType?: LarkGroupMessageType;
  toolkitIds?: string[];
}

export interface CreateLarkChatInput {
  name: string;
  ownerOpenId?: string;
  userOpenIds?: string[];
  groupMessageType?: LarkGroupMessageType;
  toolkitIds?: string[];
  uuid?: string;
  setBotManager?: boolean;
}

export interface UpdateLarkChatInput {
  groupMessageType?: LarkGroupMessageType;
  toolkitIds?: string[];
}

export interface LarkChatCreateResult {
  chatId?: string;
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
        ...(input.userOpenIds?.length ? { user_id_list: input.userOpenIds } : {}),
        ...(input.toolkitIds?.length ? { toolkit_ids: input.toolkitIds } : {})
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

  async updateChatInfo(chatId: string, input: UpdateLarkChatInput): Promise<LarkChatInfo> {
    const raw = await this.options.openApiClient.request(`/im/v1/chats/${encodePathSegment(chatId)}`, {
      method: "PUT",
      query: {
        user_id_type: "open_id"
      },
      body: {
        ...(input.groupMessageType ? { group_message_type: input.groupMessageType } : {}),
        ...(input.toolkitIds ? { toolkit_ids: input.toolkitIds } : {})
      }
    });
    return extractChatInfo(raw);
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
  const toolkitIds = arrayOfStrings(chat.toolkit_ids) ?? arrayOfStrings(data.toolkit_ids);
  return {
    chatId: firstNonEmptyString(chat.chat_id, data.chat_id),
    name: firstNonEmptyString(chat.name, chat.chat_name, chat.title, data.name, data.chat_name, data.title),
    chatMode: normalizeLarkChatMode(firstNonEmptyString(chat.chat_mode, data.chat_mode)),
    groupMessageType: normalizeLarkGroupMessageType(firstNonEmptyString(chat.group_message_type, data.group_message_type)),
    toolkitIds
  };
}

function extractChatId(raw: unknown): string | undefined {
  const data = getRecord(raw, "data");
  const chat = getRecord(data, "chat");
  return firstNonEmptyString(chat.chat_id, data.chat_id);
}

function normalizeLarkChatMode(value: string | undefined): LarkChatMode | undefined {
  if (value === "group" || value === "topic") {
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

function arrayOfStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return strings.length > 0 ? strings : undefined;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
