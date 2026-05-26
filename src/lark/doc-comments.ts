import fs from "node:fs/promises";
import path from "node:path";
import type {
  LarkDocCommentClient,
  LarkDocCommentImageRef,
  LarkDocCommentSnapshot,
  LarkDocResolver,
  ResolvedLarkDocTarget
} from "../conversation/manager.js";
import { LarkOpenApiClient, LarkOpenApiError } from "./openapi.js";

export interface LarkDocClientOptions {
  openApiClient: LarkOpenApiClient;
  commentReadMaxRetries?: number;
  commentReadRetryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const SUPPORTED_DOC_TYPES = new Set(["doc", "docx", "sheet", "slides", "bitable", "file"]);
const DOC_COMMENT_PERMISSION_NOT_READY_CODE = 1069301;

class LarkDocCommentReplyNotReadyError extends Error {
  constructor(readonly replyId: string) {
    super(`Lark doc comment reply is not visible yet: ${replyId}`);
    this.name = "LarkDocCommentReplyNotReadyError";
  }
}

interface DocxCommentBlockRefs {
  blockIds: string[];
  imageRefs: LarkDocCommentImageRef[];
}

export class LarkDocClient implements LarkDocResolver, LarkDocCommentClient {
  private readonly commentReadMaxRetries: number;
  private readonly commentReadRetryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: LarkDocClientOptions) {
    this.commentReadMaxRetries = Math.max(0, Math.floor(options.commentReadMaxRetries ?? 5));
    this.commentReadRetryBaseDelayMs = Math.max(0, options.commentReadRetryBaseDelayMs ?? 1_000);
    this.sleep = options.sleep ?? sleep;
  }

  async resolveDocTarget(url: string): Promise<ResolvedLarkDocTarget> {
    const parsed = parseLarkDocUrl(url);
    if (parsed.fileType !== "wiki") {
      return parsed;
    }

    const raw = await this.options.openApiClient.request("/wiki/v2/spaces/get_node", {
      method: "GET",
      query: { token: parsed.fileToken }
    });
    const node = getRecord(getRecord(raw, "data"), "node");
    const fileType = normalizeDocFileType(stringValue(node.obj_type));
    const fileToken = stringValue(node.obj_token);
    if (!fileType || !fileToken || !SUPPORTED_DOC_TYPES.has(fileType)) {
      throw new Error("wiki URL resolved to an unsupported document type");
    }
    return {
      fileType,
      fileToken,
      watchUrl: url.trim()
    };
  }

  async getCommentSnapshot(params: {
    fileType: string;
    fileToken: string;
    commentId: string;
    replyId?: string;
  }): Promise<LarkDocCommentSnapshot | null> {
    return this.withCommentReadRetry(() => this.getCommentSnapshotOnce(params));
  }

  private async getCommentSnapshotOnce(params: {
    fileType: string;
    fileToken: string;
    commentId: string;
    replyId?: string;
  }): Promise<LarkDocCommentSnapshot | null> {
    const rawComment = await this.batchQueryComment(params.fileType, params.fileToken, params.commentId);
    if (!rawComment) {
      return null;
    }
    const replies = await this.listReplies(params.fileType, params.fileToken, params.commentId);
    const reply = params.replyId ? findReply(replies, params.replyId) : newestReply(replies);
    if (!reply) {
      if (params.replyId) {
        throw new LarkDocCommentReplyNotReadyError(params.replyId);
      }
      return null;
    }
    const replyId = stringValue(reply.reply_id) ?? params.replyId;
    if (!replyId) {
      return null;
    }

    const replyImageRefs = imageRefsFromReply(reply, params.fileToken);
    const docxBlockRefs = await this.findDocxCommentBlockRefsBestEffort(params.fileType, params.fileToken, params.commentId);
    const imageRefs = dedupeImageRefs([...replyImageRefs, ...docxBlockRefs.imageRefs]);

    return {
      fileType: params.fileType,
      fileToken: params.fileToken,
      commentId: params.commentId,
      replyId,
      isWhole: booleanValue(rawComment.is_whole),
      authorOpenId: stringValue(reply.user_id) ?? stringValue(rawComment.user_id) ?? "",
      text: replyText(reply),
      quote: stringValue(rawComment.quote),
      quoteBlockIds: docxBlockRefs.blockIds,
      imageKeys: imageRefs.map((image) => image.fileToken),
      imageRefs,
      isDone: booleanValue(rawComment.is_done),
      isSolved: booleanValue(rawComment.is_solved),
      createTime: numberValue(reply.create_time),
      rawComment,
      rawReply: reply
    };
  }

  private async withCommentReadRetry<T>(operation: () => Promise<T>): Promise<T> {
    const attempts = this.commentReadMaxRetries + 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= attempts - 1 || !isRetryableCommentReadError(error)) {
          throw error;
        }
        await this.sleep(this.commentReadRetryBaseDelayMs * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async updateReaction(params: {
    fileType: string;
    fileToken: string;
    replyId: string;
    reactionType: string;
    action: "add" | "delete";
  }): Promise<void> {
    await this.options.openApiClient.request(
      `/drive/v2/files/${encodePathSegment(params.fileToken)}/comments/reaction`,
      {
        method: "POST",
        query: { file_type: params.fileType },
        body: {
          action: params.action,
          reply_id: params.replyId,
          reaction_type: params.reactionType
        }
      }
    );
  }

  async replyToComment(params: {
    fileType: string;
    fileToken: string;
    commentId: string;
    isWhole?: boolean;
    text: string;
  }): Promise<{ replyId?: string; raw?: unknown }> {
    if (params.isWhole) {
      const raw = await this.options.openApiClient.request(
        `/drive/v1/files/${encodePathSegment(params.fileToken)}/comments`,
        {
          method: "POST",
          query: { file_type: params.fileType },
          body: {
            comment_id: params.commentId,
            reply_list: {
              replies: [
                {
                  content: commentReplyContent(params.text)
                }
              ]
            }
          }
        }
      );
      return {
        replyId: firstReplyIdFromComment(raw),
        raw
      };
    }

    const raw = await this.options.openApiClient.request(
      `/drive/v1/files/${encodePathSegment(params.fileToken)}/comments/${encodePathSegment(params.commentId)}/replies`,
      {
        method: "POST",
        query: { file_type: params.fileType },
        body: {
          content: commentReplyContent(params.text)
        }
      }
    );
    return {
      replyId: stringValue(getRecord(raw, "data").reply_id),
      raw
    };
  }

  async downloadCommentImage(params: {
    fileToken: string;
    outputDir: string;
    driveRouteToken?: string;
    fileName?: string;
  }): Promise<{
    path: string;
    resourceType: "image";
    fileKey: string;
    fileName?: string;
    size: number;
    contentType?: string;
  }> {
    const response = params.driveRouteToken
      ? await this.options.openApiClient.download(
        `/drive/v1/medias/${encodePathSegment(params.fileToken)}/download`,
        {
          method: "GET",
          query: {
            extra: JSON.stringify({ drive_route_token: params.driveRouteToken })
          }
        }
      )
      : await this.options.openApiClient.download(
        `/drive/v1/files/${encodePathSegment(params.fileToken)}/download`,
        { method: "GET" }
      );
    await fs.mkdir(params.outputDir, { recursive: true });
    const fileName = uniqueSafeFileName(params.fileName ?? params.fileToken, response.contentType, response.contentDisposition);
    const filePath = await uniqueFilePath(params.outputDir, fileName);
    await fs.writeFile(filePath, response.body);
    return {
      path: filePath,
      resourceType: "image",
      fileKey: params.fileToken,
      fileName: path.basename(filePath),
      size: response.body.byteLength,
      contentType: response.contentType
    };
  }

  private async batchQueryComment(fileType: string, fileToken: string, commentId: string): Promise<Record<string, unknown> | undefined> {
    const raw = await this.options.openApiClient.request(
      `/drive/v1/files/${encodePathSegment(fileToken)}/comments/batch_query`,
      {
        method: "POST",
        query: {
          file_type: fileType,
          user_id_type: "open_id"
        },
        body: {
          comment_ids: [commentId],
          need_reaction: true
        }
      }
    );
    const items = getArray(getRecord(raw, "data"), "items");
    return items.find((item) => stringValue(item.comment_id) === commentId);
  }

  private async listReplies(fileType: string, fileToken: string, commentId: string): Promise<Record<string, unknown>[]> {
    const replies: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    do {
      const raw = await this.options.openApiClient.request(
        `/drive/v1/files/${encodePathSegment(fileToken)}/comments/${encodePathSegment(commentId)}/replies`,
        {
          method: "GET",
          query: {
            file_type: fileType,
            user_id_type: "open_id",
            need_reaction: true,
            page_size: 100,
            page_token: pageToken
          }
        }
      );
      const data = getRecord(raw, "data");
      replies.push(...getArray(data, "items"));
      pageToken = booleanValue(data.has_more) ? stringValue(data.page_token) : undefined;
    } while (pageToken);
    return replies;
  }

  private async findDocxCommentBlockRefs(
    fileType: string,
    fileToken: string,
    commentId: string
  ): Promise<DocxCommentBlockRefs> {
    if (fileType !== "docx") {
      return emptyDocxCommentBlockRefs();
    }

    const blockIds: string[] = [];
    const imageRefs: LarkDocCommentImageRef[] = [];
    let pageToken: string | undefined;
    do {
      const raw = await this.options.openApiClient.request(
        `/docx/v1/documents/${encodePathSegment(fileToken)}/blocks`,
        {
          method: "GET",
          query: {
            page_size: 500,
            page_token: pageToken
          }
        }
      );
      const data = getRecord(raw, "data");
      for (const block of getArray(data, "items")) {
        const commentIds = getStringArray(block, "comment_ids");
        if (!commentIds.includes(commentId)) {
          continue;
        }
        const blockId = stringValue(block.block_id);
        if (blockId) {
          blockIds.push(blockId);
        }
        if (numberValue(block.block_type) !== 27) {
          continue;
        }
        const image = getRecord(block, "image");
        const imageToken = stringValue(image.token);
        if (!imageToken) {
          continue;
        }
        imageRefs.push({
          fileToken: imageToken,
          source: "doc_block",
          blockId,
          driveRouteToken: fileToken,
          fileName: blockId ? `doc-image-${blockId}` : undefined
        });
      }
      pageToken = booleanValue(data.has_more) ? stringValue(data.page_token) : undefined;
    } while (pageToken);
    return {
      blockIds: dedupeStrings(blockIds),
      imageRefs: dedupeImageRefs(imageRefs)
    };
  }

  private async findDocxCommentBlockRefsBestEffort(
    fileType: string,
    fileToken: string,
    commentId: string
  ): Promise<DocxCommentBlockRefs> {
    try {
      return await this.findDocxCommentBlockRefs(fileType, fileToken, commentId);
    } catch {
      return emptyDocxCommentBlockRefs();
    }
  }
}

function commentReplyContent(text: string): Record<string, unknown> {
  return {
    elements: [
      {
        type: "text_run",
        text_run: {
          text: sanitizeCommentReplyText(text)
        }
      }
    ]
  };
}

function firstReplyIdFromComment(raw: unknown): string | undefined {
  const data = getRecord(raw, "data");
  const replyList = getRecord(data, "reply_list");
  const replies = getArray(replyList, "replies");
  return stringValue(replies[0]?.reply_id);
}

function parseLarkDocUrl(value: string): ResolvedLarkDocTarget {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("用法：/watch <lark_doc_url> [owner|all|none]");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const typeIndex = parts.findIndex((part) => ["doc", "docs", "docx", "sheets", "sheet", "slides", "wiki", "base", "bitable", "file"].includes(part));
  if (typeIndex < 0 || !parts[typeIndex + 1]) {
    throw new Error("未能从 URL 解析出文档类型和 token");
  }
  const fileType = normalizeDocFileType(parts[typeIndex]);
  const fileToken = parts[typeIndex + 1]!;
  if (!fileType || (fileType !== "wiki" && !SUPPORTED_DOC_TYPES.has(fileType))) {
    throw new Error(`不支持的文档类型：${parts[typeIndex]}`);
  }
  return {
    fileType,
    fileToken,
    watchUrl: value.trim()
  };
}

function normalizeDocFileType(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "docs") {
    return "doc";
  }
  if (normalized === "sheets") {
    return "sheet";
  }
  if (normalized === "base") {
    return "bitable";
  }
  return normalized;
}

function findReply(replies: Record<string, unknown>[], replyId: string | undefined): Record<string, unknown> | undefined {
  if (!replyId) {
    return undefined;
  }
  return replies.find((reply) => stringValue(reply.reply_id) === replyId);
}

function newestReply(replies: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return replies
    .map((reply, index) => ({ reply, index, timestamp: replyTimestamp(reply) ?? 0 }))
    .sort((left, right) => right.timestamp - left.timestamp || right.index - left.index)[0]
    ?.reply;
}

function replyTimestamp(reply: Record<string, unknown>): number | undefined {
  return numberValue(reply.create_time) ?? numberValue(reply.update_time);
}

function isRetryableCommentReadError(error: unknown): boolean {
  // Lark can emit comment_add before a freshly mentioned bot can read that comment.
  return error instanceof LarkDocCommentReplyNotReadyError ||
    error instanceof LarkOpenApiError && error.detail.code === DOC_COMMENT_PERMISSION_NOT_READY_CODE;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function replyText(reply: Record<string, unknown>): string {
  const content = getRecord(reply, "content");
  const elements = getArray(content, "elements");
  if (elements.length === 0) {
    return textContentValue(content.text) ?? "";
  }
  return elements.map(textFromElement).filter(Boolean).join("");
}

function textFromElement(element: Record<string, unknown>): string {
  const type = stringValue(element.type);
  if (type === "text_run") {
    const textRun = getRecord(element, "text_run");
    return textContentValue(textRun.text) ?? textContentValue(textRun.content) ?? textContentValue(element.text) ?? "";
  }
  if (type === "person") {
    const person = getRecord(element, "person");
    return `@${stringValue(person.name) ?? stringValue(person.user_id) ?? stringValue(element.text) ?? ""}`;
  }
  if (type === "docs_link") {
    const link = getRecord(element, "docs_link");
    return stringValue(link.url) ?? stringValue(link.text) ?? stringValue(element.text) ?? "";
  }
  return textContentValue(element.text) ?? "";
}

function imageRefsFromReply(reply: Record<string, unknown>, driveRouteToken: string): LarkDocCommentImageRef[] {
  const extra = getRecord(reply, "extra");
  return getUnknownArray(extra, "image_list")
    .map((item) => typeof item === "string"
      ? item
      : isRecord(item)
        ? stringValue(item.file_token) ?? stringValue(item.image_key) ?? stringValue(item.key) ?? stringValue(item.token)
        : undefined)
    .filter((item): item is string => !!item)
    .map((fileToken) => ({
      fileToken,
      source: "reply" as const,
      driveRouteToken,
      fileName: `comment-image-${fileToken}`
    }));
}

function emptyDocxCommentBlockRefs(): DocxCommentBlockRefs {
  return {
    blockIds: [],
    imageRefs: []
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function dedupeImageRefs(refs: LarkDocCommentImageRef[]): LarkDocCommentImageRef[] {
  const seen = new Set<string>();
  const result: LarkDocCommentImageRef[] = [];
  for (const ref of refs) {
    const key = `${ref.source}:${ref.fileToken}:${ref.driveRouteToken ?? ""}:${ref.blockId ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function sanitizeCommentReplyText(text: string): string {
  const escaped = Array.from(text.trim()).map(escapeCommentReplyChar);
  const joined = escaped.join("");
  if (joined.length <= 10_000) {
    return joined;
  }
  const suffix = "\n[已截断]";
  const prefixLimit = 10_000 - suffix.length;
  const prefix: string[] = [];
  let length = 0;
  for (const part of escaped) {
    if (length + part.length > prefixLimit) {
      break;
    }
    prefix.push(part);
    length += part.length;
  }
  return `${prefix.join("")}${suffix}`;
}

function escapeCommentReplyChar(char: string): string {
  if (char === "<") {
    return "&lt;";
  }
  if (char === ">") {
    return "&gt;";
  }
  return char;
}

function getRecord(value: unknown, key?: string): Record<string, unknown> {
  const target = key === undefined ? value : isRecord(value) ? value[key] : undefined;
  return isRecord(target) ? target : {};
}

function getArray(value: unknown, key: string): Record<string, unknown>[] {
  const target = isRecord(value) ? value[key] : undefined;
  return Array.isArray(target) ? target.filter(isRecord) : [];
}

function getUnknownArray(value: unknown, key: string): unknown[] {
  const target = isRecord(value) ? value[key] : undefined;
  return Array.isArray(target) ? target : [];
}

function getStringArray(value: unknown, key: string): string[] {
  const target = isRecord(value) ? value[key] : undefined;
  return Array.isArray(target) ? target.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function textContentValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return false;
}

function uniqueSafeFileName(fileToken: string, contentType: string | undefined, contentDisposition: string | undefined): string {
  const fromDisposition = fileNameFromContentDisposition(contentDisposition);
  const base = path.basename(fromDisposition ?? fileToken).replace(/[\u0000-\u001f\u007f]/g, "_").trim() || "comment_image";
  return path.extname(base) ? base : `${base}${extensionForContentType(contentType)}`;
}

function fileNameFromContentDisposition(contentDisposition: string | undefined): string | undefined {
  if (!contentDisposition) {
    return undefined;
  }
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  return /filename="?([^";]+)"?/i.exec(contentDisposition)?.[1];
}

async function uniqueFilePath(outputDir: string, fileName: string): Promise<string> {
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? fileName : `${stem}(${suffix})${extension}`;
    const filePath = path.join(outputDir, candidate);
    try {
      await fs.access(filePath);
    } catch {
      return filePath;
    }
  }
}

function extensionForContentType(contentType: string | undefined): string {
  switch (contentType?.split(";")[0]?.trim().toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
