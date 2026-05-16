import type { ConversationType, RoleName, TwinnyConfig } from "../types.js";
import { TwinnyError } from "../errors.js";
import {
  assertValidConversationKey,
  createGroupConversationKey,
  createP2PConversationKey
} from "../workspace/slug.js";

export function conversationKeyForP2p(chatId: string): string {
  try {
    return createP2PConversationKey(chatId);
  } catch {
    throw new TwinnyError(`Invalid p2p chat id: ${chatId}`, "INVALID_CHAT_ID");
  }
}

export function conversationKeyForGroup(chatId: string): string {
  try {
    return createGroupConversationKey(chatId);
  } catch {
    throw new TwinnyError(`Invalid group chat id: ${chatId}`, "INVALID_CHAT_ID");
  }
}

export function validateConversationKey(conversationKey: string): void {
  try {
    assertValidConversationKey(conversationKey);
  } catch {
    throw new TwinnyError(`Invalid conversation key: ${conversationKey}`, "INVALID_CONVERSATION_KEY");
  }
}

export function roleForSender(config: TwinnyConfig, senderOpenId: string): RoleName {
  return senderOpenId === config.owner.openId ? "owner" : "guest";
}

export function conversationTypeForChat(chatType: string): ConversationType | null {
  switch (chatType.toLowerCase()) {
    case "p2p":
    case "p2p_chat":
    case "private":
    case "private_chat":
      return "p2p";
    case "group":
    case "group_chat":
      return "group";
    case "topic_group":
    case "topic":
      return "topic_group";
    default:
      return null;
  }
}

export function conversationKeyForChat(type: ConversationType, message: { chatId: string; senderOpenId: string }): string {
  return type === "p2p" ? conversationKeyForP2p(message.senderOpenId) : conversationKeyForGroup(message.chatId);
}

export function isGroupConversationType(type: ConversationType): boolean {
  return type === "group" || type === "topic_group";
}
