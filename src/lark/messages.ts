import { toErrorMessage } from "../errors.js";
import { DEFAULT_LARK_WORKING_REACTION, type LarkReactionHandle } from "../types.js";
import { LarkOpenApiClient } from "./openapi.js";
import type { LarkLogger, LarkSendMessageResult } from "./types.js";

export interface LarkMessageSenderOptions {
  openApiClient: LarkOpenApiClient;
  logger?: LarkLogger;
}

export interface TextMessageOptions {
  uuid?: string;
  signal?: AbortSignal;
}

export interface ReactionOptions {
  signal?: AbortSignal;
}

export type LarkPostNode =
  | { tag: "md"; text: string }
  | { tag: "img"; image_key: string }
  | { tag: "media"; file_key: string; image_key?: string };

export type LarkPostParagraph = LarkPostNode[];

export class LarkMessageSender {
  private readonly openApiClient: LarkOpenApiClient;
  private readonly logger?: LarkLogger;

  constructor(options: LarkMessageSenderOptions) {
    this.openApiClient = options.openApiClient;
    this.logger = options.logger;
  }

  async replyText(messageId: string, text: string, options: TextMessageOptions = {}): Promise<LarkSendMessageResult> {
    const raw = await this.openApiClient.request(`/im/v1/messages/${encodePathSegment(messageId)}/reply`, {
      method: "POST",
      signal: options.signal,
      body: {
        content: JSON.stringify({ text }),
        msg_type: "text",
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
        content: JSON.stringify(createPostContent(content)),
        msg_type: "post",
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
        content: JSON.stringify({ file_key: fileKey }),
        msg_type: "file",
        ...(options.uuid ? { uuid: options.uuid } : {})
      }
    });
    return {
      messageId: extractMessageId(raw),
      raw
    };
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
        content: JSON.stringify({ text }),
        msg_type: "text",
        ...(options.uuid ? { uuid: options.uuid } : {})
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

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
