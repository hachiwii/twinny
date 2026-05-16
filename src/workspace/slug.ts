import { TwinnyError } from "../errors.js";

export const p2pConversationKeyPrefix = "p2p_";
export const groupConversationKeyPrefix = "group_";
const legacyP2PConversationKeyPrefix = "p2p:";
const legacyGroupConversationKeyPrefix = "group:";

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
  const prefix = conversationKeyPrefix(conversationKey);
  if (prefix !== p2pConversationKeyPrefix && prefix !== legacyP2PConversationKeyPrefix) {
    throw new TwinnyError(
      `conversationKey must start with ${p2pConversationKeyPrefix}`,
      "CONVERSATION_KEY_INVALID"
    );
  }
  return conversationKey.slice(prefix.length);
}

export function getGroupChatIdFromConversationKey(conversationKey: string): string {
  assertValidConversationKey(conversationKey);
  const prefix = conversationKeyPrefix(conversationKey);
  if (prefix !== groupConversationKeyPrefix && prefix !== legacyGroupConversationKeyPrefix) {
    throw new TwinnyError(
      `conversationKey must start with ${groupConversationKeyPrefix}`,
      "CONVERSATION_KEY_INVALID"
    );
  }
  return conversationKey.slice(prefix.length);
}

export function assertValidConversationKey(conversationKey: string): void {
  const prefix = conversationKeyPrefix(conversationKey);
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
  if (value.includes(":")) {
    throw new TwinnyError(`${field} must not contain colons`, "WORKSPACE_KEY_COLON");
  }
  if (value === "." || value.includes("..")) {
    throw new TwinnyError(`${field} must not contain dot traversal`, "WORKSPACE_KEY_DOT_SEGMENT");
  }
}

function conversationKeyPrefix(conversationKey: string): string | undefined {
  if (conversationKey.startsWith(p2pConversationKeyPrefix)) {
    return p2pConversationKeyPrefix;
  }
  if (conversationKey.startsWith(groupConversationKeyPrefix)) {
    return groupConversationKeyPrefix;
  }
  if (conversationKey.startsWith(legacyP2PConversationKeyPrefix)) {
    return legacyP2PConversationKeyPrefix;
  }
  if (conversationKey.startsWith(legacyGroupConversationKeyPrefix)) {
    return legacyGroupConversationKeyPrefix;
  }
  return undefined;
}
