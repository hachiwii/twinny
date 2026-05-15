import type { ConversationType, RoleName, TwinnyConfig } from "../types.js";
import { TwinnyError } from "../errors.js";

const unsafeConversationKey = /(^$|\/|(^|:)\.\.($|:))/;

export function conversationKeyForP2p(chatId: string): string {
  if (!chatId || chatId.includes("/") || chatId.includes("..")) {
    throw new TwinnyError(`Invalid p2p chat id: ${chatId}`, "INVALID_CHAT_ID");
  }
  return `p2p:${chatId}`;
}

export function validateConversationKey(conversationKey: string): void {
  if (unsafeConversationKey.test(conversationKey) || conversationKey.split(":").some((part) => part.length === 0)) {
    throw new TwinnyError(`Invalid conversation key: ${conversationKey}`, "INVALID_CONVERSATION_KEY");
  }
}

export function roleForSender(config: TwinnyConfig, senderOpenId: string): RoleName {
  return senderOpenId === config.owner.openId ? "owner" : "guest";
}

export function conversationTypeForChat(chatType: string): ConversationType | null {
  return chatType === "p2p" ? "p2p" : null;
}
