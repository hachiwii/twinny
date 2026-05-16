import { TwinnyError } from "../errors.js";

export const p2pConversationKeyPrefix = "p2p:";
export const groupConversationKeyPrefix = "group:";

export function createP2PConversationKey(chatId: string): string {
  assertSafePathSegment(chatId, "chatId");
  return `${p2pConversationKeyPrefix}${chatId}`;
}

export function createGroupConversationKey(chatId: string): string {
  assertSafePathSegment(chatId, "chatId");
  return `${groupConversationKeyPrefix}${chatId}`;
}

export function getP2PChatIdFromConversationKey(conversationKey: string): string {
  assertValidConversationKey(conversationKey);
  if (!conversationKey.startsWith(p2pConversationKeyPrefix)) {
    throw new TwinnyError(
      `conversationKey must start with ${p2pConversationKeyPrefix}`,
      "CONVERSATION_KEY_INVALID"
    );
  }
  return conversationKey.slice(p2pConversationKeyPrefix.length);
}

export function getGroupChatIdFromConversationKey(conversationKey: string): string {
  assertValidConversationKey(conversationKey);
  if (!conversationKey.startsWith(groupConversationKeyPrefix)) {
    throw new TwinnyError(
      `conversationKey must start with ${groupConversationKeyPrefix}`,
      "CONVERSATION_KEY_INVALID"
    );
  }
  return conversationKey.slice(groupConversationKeyPrefix.length);
}

export function assertValidConversationKey(conversationKey: string): void {
  assertSafePathSegment(conversationKey, "conversationKey");
  const prefix = conversationKey.startsWith(p2pConversationKeyPrefix)
    ? p2pConversationKeyPrefix
    : conversationKey.startsWith(groupConversationKeyPrefix)
      ? groupConversationKeyPrefix
      : undefined;
  if (!prefix) {
    throw new TwinnyError(
      `conversationKey must start with ${p2pConversationKeyPrefix} or ${groupConversationKeyPrefix}`,
      "CONVERSATION_KEY_INVALID"
    );
  }

  const chatId = conversationKey.slice(prefix.length);
  assertSafePathSegment(chatId, "chatId");
}

export function isValidConversationKey(conversationKey: string): boolean {
  try {
    assertValidConversationKey(conversationKey);
    return true;
  } catch {
    return false;
  }
}

function assertSafePathSegment(value: string, field: string): void {
  if (value.length === 0) {
    throw new TwinnyError(`${field} must not be empty`, "WORKSPACE_KEY_EMPTY");
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new TwinnyError(`${field} must not contain slashes`, "WORKSPACE_KEY_SLASH");
  }
  if (value === "." || value.includes("..")) {
    throw new TwinnyError(`${field} must not contain dot traversal`, "WORKSPACE_KEY_DOT_SEGMENT");
  }
}
