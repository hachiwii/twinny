import { toErrorMessage } from "../errors.js";
import { DEFAULT_LARK_WORKING_REACTION, type LarkMessageRedactionConfig, type LarkReactionHandle } from "../types.js";
import { LarkOpenApiClient } from "./openapi.js";
import { normalizeLarkMessageRedactionConfig, redactLarkMessageContent } from "./redactor.js";
import type { LarkLogger, LarkSendMessageResult } from "./types.js";

export interface LarkMessageSenderOptions {
  openApiClient: LarkOpenApiClient;
  logger?: LarkLogger;
  redaction?: Partial<LarkMessageRedactionConfig>;
}

export interface LarkMessageReaderOptions {
  openApiClient: LarkOpenApiClient;
}

export class LarkMessageUnavailableError extends Error {
  readonly code = "LARK_MESSAGE_UNAVAILABLE";

  constructor(readonly messageId: string) {
    super(`Lark message is unavailable: ${messageId}`);
    this.name = "LarkMessageUnavailableError";
  }
}

export function isLarkMessageUnavailableError(error: unknown): error is LarkMessageUnavailableError {
  return error instanceof LarkMessageUnavailableError ||
    (
      !!error &&
      typeof error === "object" &&
      (error as Record<string, unknown>).code === "LARK_MESSAGE_UNAVAILABLE"
    );
}

export interface TextMessageOptions {
  uuid?: string;
  replyInThread?: boolean;
  signal?: AbortSignal;
}

export interface ReactionOptions {
  signal?: AbortSignal;
}

export interface ForwardThreadOptions {
  uuid?: string;
  signal?: AbortSignal;
}

export interface MessageReadUsersOptions {
  signal?: AbortSignal;
  pageSize?: number;
}

export type LarkPostNode =
  | { tag: "md"; text: string }
  | { tag: "text"; text: string }
  | { tag: "at"; user_id: string; user_name?: string }
  | { tag: "img"; image_key: string }
  | { tag: "media"; file_key: string; image_key?: string };

export type LarkPostParagraph = LarkPostNode[];

export type LarkInteractiveCard = Record<string, unknown>;

export class LarkMessageSender {
  private readonly openApiClient: LarkOpenApiClient;
  private readonly logger?: LarkLogger;
  private readonly redaction: LarkMessageRedactionConfig;

  constructor(options: LarkMessageSenderOptions) {
    this.openApiClient = options.openApiClient;
    this.logger = options.logger;
    this.redaction = normalizeLarkMessageRedactionConfig(options.redaction);
  }

  async replyText(messageId: string, text: string, options: TextMessageOptions = {}): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request(`/im/v1/messages/${encodePathSegment(messageId)}/reply`, {
      method: "POST",
      signal: options.signal,
      body: {
        content: this.stringifyMessageContent({ text }),
        msg_type: "text",
        ...(options.replyInThread ? { reply_in_thread: true } : {}),
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async replyMarkdown(
    messageId: string,
    markdown: string,
    options: TextMessageOptions = {}
  ): Promise<LarkSendMessageResult> {
    return this.replyPost(messageId, [[{ tag: "md", text: markdown }]], options);
  }

  async replyPost(
    messageId: string,
    content: LarkPostParagraph[],
    options: TextMessageOptions = {}
  ): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request(`/im/v1/messages/${encodePathSegment(messageId)}/reply`, {
      method: "POST",
      signal: options.signal,
      body: {
        content: this.stringifyMessageContent(createPostContent(content)),
        msg_type: "post",
        ...(options.replyInThread ? { reply_in_thread: true } : {}),
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async replyFile(messageId: string, fileKey: string, options: TextMessageOptions = {}): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request(`/im/v1/messages/${encodePathSegment(messageId)}/reply`, {
      method: "POST",
      signal: options.signal,
      body: {
        content: this.stringifyMessageContent({ file_key: fileKey }),
        msg_type: "file",
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async replyImage(messageId: string, imageKey: string, options: TextMessageOptions = {}): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request(`/im/v1/messages/${encodePathSegment(messageId)}/reply`, {
      method: "POST",
      signal: options.signal,
      body: {
        content: this.stringifyMessageContent({ image_key: imageKey }),
        msg_type: "image",
        ...(options.replyInThread ? { reply_in_thread: true } : {}),
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async replyInteractiveCard(
    messageId: string,
    card: LarkInteractiveCard,
    options: TextMessageOptions = {}
  ): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request(`/im/v1/messages/${encodePathSegment(messageId)}/reply`, {
      method: "POST",
      signal: options.signal,
      body: {
        content: this.stringifyMessageContent(card),
        msg_type: "interactive",
        ...(options.replyInThread ? { reply_in_thread: true } : {}),
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async patchInteractiveCard(
    messageId: string,
    card: LarkInteractiveCard,
    options: TextMessageOptions = {}
  ): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request(`/im/v1/messages/${encodePathSegment(messageId)}`, {
      method: "PATCH",
      signal: options.signal,
      body: {
        content: this.stringifyMessageContent(card),
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async deleteMessage(messageId: string, options: ReactionOptions = {}): Promise<void> {
    await this.openApiClient.request(`/im/v1/messages/${encodePathSegment(messageId)}`, {
      method: "DELETE",
      signal: options.signal
    });
  }

  async deleteEphemeralMessage(messageId: string, options: ReactionOptions = {}): Promise<void> {
    await this.openApiClient.request("/ephemeral/v1/delete", {
      method: "POST",
      signal: options.signal,
      body: {
        message_id: messageId
      }
    });
  }

  async listMessageReadOpenIds(messageId: string, options: MessageReadUsersOptions = {}): Promise<string[]> {
    const readOpenIds = new Set<string>();
    const pageSize = options.pageSize ?? 100;
    let pageToken: string | undefined;

    do {
      const raw = await this.openApiClient.request(`/im/v1/messages/${encodePathSegment(messageId)}/read_users`, {
        method: "GET",
        query: {
          user_id_type: "open_id",
          page_size: pageSize,
          page_token: pageToken
        },
        signal: options.signal
      });
      const data = getData(raw);
      for (const item of Array.isArray(data.items) ? data.items : []) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          continue;
        }
        const userId = (item as Record<string, unknown>).user_id;
        if (typeof userId === "string" && userId.trim()) {
          readOpenIds.add(userId);
        }
      }
      const nextPageToken = typeof data.page_token === "string" && data.page_token.trim() ? data.page_token : undefined;
      pageToken = data.has_more === true ? nextPageToken : undefined;
    } while (pageToken);

    return [...readOpenIds];
  }

  async sendTextToOpenId(openId: string, text: string, options: TextMessageOptions = {}): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request("/im/v1/messages", {
      method: "POST",
      query: {
        receive_id_type: "open_id"
      },
      signal: options.signal,
      body: {
        receive_id: openId,
        content: this.stringifyMessageContent({ text }),
        msg_type: "text",
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async sendPostToOpenId(
    openId: string,
    content: LarkPostParagraph[],
    options: TextMessageOptions = {}
  ): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request("/im/v1/messages", {
      method: "POST",
      query: {
        receive_id_type: "open_id"
      },
      signal: options.signal,
      body: {
        receive_id: openId,
        content: this.stringifyMessageContent(createPostContent(content)),
        msg_type: "post",
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async sendInteractiveCardToOpenId(
    openId: string,
    card: LarkInteractiveCard,
    options: TextMessageOptions = {}
  ): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request("/im/v1/messages", {
      method: "POST",
      query: {
        receive_id_type: "open_id"
      },
      signal: options.signal,
      body: {
        receive_id: openId,
        content: this.stringifyMessageContent(card),
        msg_type: "interactive",
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async sendTextToChatId(chatId: string, text: string, options: TextMessageOptions = {}): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request("/im/v1/messages", {
      method: "POST",
      query: {
        receive_id_type: "chat_id"
      },
      signal: options.signal,
      body: {
        receive_id: chatId,
        content: this.stringifyMessageContent({ text }),
        msg_type: "text",
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async sendPostToChatId(
    chatId: string,
    content: LarkPostParagraph[],
    options: TextMessageOptions = {}
  ): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request("/im/v1/messages", {
      method: "POST",
      query: {
        receive_id_type: "chat_id"
      },
      signal: options.signal,
      body: {
        receive_id: chatId,
        content: this.stringifyMessageContent(createPostContent(content)),
        msg_type: "post",
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async sendInteractiveCardToChatId(
    chatId: string,
    card: LarkInteractiveCard,
    options: TextMessageOptions = {}
  ): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request("/im/v1/messages", {
      method: "POST",
      query: {
        receive_id_type: "chat_id"
      },
      signal: options.signal,
      body: {
        receive_id: chatId,
        content: this.stringifyMessageContent(card),
        msg_type: "interactive",
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async sendEphemeralInteractiveCardToChatId(
    chatId: string,
    openId: string,
    card: LarkInteractiveCard,
    options: TextMessageOptions = {}
  ): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request("/ephemeral/v1/send", {
      method: "POST",
      signal: options.signal,
      body: {
        chat_id: chatId,
        open_id: openId,
        msg_type: "interactive",
        card: this.redactMessageContent(card)
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async forwardThreadToThread(
    threadId: string,
    receiveThreadId: string,
    options: ForwardThreadOptions = {}
  ): Promise<LarkSendMessageResult> {
    return this.forwardThread(threadId, receiveThreadId, "thread_id", options);
  }

  async forwardThread(
    threadId: string,
    receiveId: string,
    receiveIdType: "thread_id" | "chat_id",
    options: ForwardThreadOptions = {}
  ): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request(`/im/v1/threads/${encodePathSegment(threadId)}/forward`, {
      method: "POST",
      query: {
        receive_id_type: receiveIdType,
        ...(options.uuid ? { uuid: options.uuid } : {})
      },
      signal: options.signal,
      body: {
        receive_id: receiveId
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
  }

  async createReaction(
    messageId: string,
    emojiType = DEFAULT_LARK_WORKING_REACTION,
    options: ReactionOptions = {}
  ): Promise<LarkReactionHandle | null> {
    const normalizedEmojiType = emojiType.trim();
    if (!normalizedEmojiType) {
      this.logger?.warn?.({ messageId }, "Lark reaction emoji_type is empty; continuing without reaction");
      return null;
    }

    try {
      const raw = await this.openApiClient.request(`/im/v1/messages/${encodePathSegment(messageId)}/reactions`, {
        method: "POST",
        signal: options.signal,
        body: {
          reaction_type: {
            emoji_type: normalizedEmojiType
          }
        }
      });
      const reactionId = extractReactionId(raw);
      if (!reactionId) {
        this.logger?.warn?.({ messageId, emojiType: normalizedEmojiType, raw }, "Lark reaction response did not include reaction_id");
        return null;
      }
      return { messageId, reactionId };
    } catch (error) {
      this.logger?.warn?.(
        { messageId, emojiType: normalizedEmojiType, error: toErrorMessage(error) },
        "failed to create Lark reaction; continuing without reaction"
      );
      return null;
    }
  }

  async createTypingReaction(messageId: string, options: ReactionOptions = {}): Promise<LarkReactionHandle | null> {
    return this.createReaction(messageId, DEFAULT_LARK_WORKING_REACTION, options);
  }

  async deleteReaction(handle: LarkReactionHandle | null | undefined, options: ReactionOptions = {}): Promise<void> {
    if (!handle) {
      return;
    }

    try {
      await this.openApiClient.request(
        `/im/v1/messages/${encodePathSegment(handle.messageId)}/reactions/${encodePathSegment(handle.reactionId)}`,
        {
          method: "DELETE",
          signal: options.signal
        }
      );
    } catch (error) {
      this.logger?.warn?.(
        { messageId: handle.messageId, reactionId: handle.reactionId, error: toErrorMessage(error) },
        "failed to delete Lark reaction; continuing"
      );
    }
  }

  async deleteTypingReaction(handle: LarkReactionHandle | null | undefined, options: ReactionOptions = {}): Promise<void> {
    await this.deleteReaction(handle, options);
  }

  private stringifyMessageContent(content: unknown): string {
    return JSON.stringify(this.redactMessageContent(content));
  }

  private redactMessageContent(content: unknown): unknown {
    return redactLarkMessageContent(content, this.redaction);
  }
}

export class LarkMessageReader {
  constructor(private readonly options: LarkMessageReaderOptions) {}

  async getMessage(messageId: string): Promise<unknown> {
    const raw = await this.options.openApiClient.request("/im/v1/messages/mget", {
      method: "GET",
      query: {
        card_msg_content_type: "user_card_content",
        message_ids: messageId
      }
    });
    const message = extractFetchedMessage(raw, messageId);
    if (!message || isFetchedMessageDeleted(message)) {
      throw new LarkMessageUnavailableError(messageId);
    }
    return message;
  }

  async getMessageItems(messageId: string): Promise<unknown[]> {
    const raw = await this.options.openApiClient.request(`/im/v1/messages/${encodePathSegment(messageId)}`, {
      method: "GET",
      query: {
        user_id_type: "open_id",
        card_msg_content_type: "user_card_content"
      }
    });
    const data = getData(raw);
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
      throw new LarkMessageUnavailableError(messageId);
    }
    const message = items.find(
      (item) => item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).message_id === messageId
    );
    if (!message || isFetchedMessageDeleted(message)) {
      throw new LarkMessageUnavailableError(messageId);
    }
    return items;
  }
}

function extractMessageId(raw: unknown): string | undefined {
  const data = getData(raw);
  const messageId = data.message_id;
  return typeof messageId === "string" ? messageId : undefined;
}

function createPostContent(content: LarkPostParagraph[]) {
  return {
    zh_cn: {
      content
    }
  };
}

function extractReactionId(raw: unknown): string | undefined {
  const data = getData(raw);
  const reactionId = data.reaction_id;
  return typeof reactionId === "string" ? reactionId : undefined;
}

function getData(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const maybeData = (raw as Record<string, unknown>).data;
  return maybeData && typeof maybeData === "object" && !Array.isArray(maybeData) ? (maybeData as Record<string, unknown>) : {};
}

function extractFetchedMessage(raw: unknown, messageId: string): unknown {
  const data = getData(raw);
  const candidates = [
    data.items,
    data.messages,
    data.message
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const match = candidate.find(
        (item) => item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).message_id === messageId
      );
      if (match) {
        return match;
      }
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (record.message_id === messageId) {
        return record;
      }
    }
  }
  return undefined;
}

function isFetchedMessageDeleted(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const deleted = (message as Record<string, unknown>).deleted;
  return deleted === true || deleted === "true";
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
