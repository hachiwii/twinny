import type {
  IncomingLarkBotMenuAction,
  IncomingLarkMention,
  IncomingLarkMessage,
  IncomingLarkMessageRecall,
  IncomingLarkMessageResource
} from "../types.js";

export interface RawLarkMessageReceiveEvent {
  event_id?: string;
  uuid?: string;
  create_time?: string;
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    name?: string;
    sender_name?: string;
    display_name?: string;
    sender_display_name?: string;
    sender_type?: string;
    tenant_key?: string;
  };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    create_time?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    mentions?: unknown;
    content?: unknown;
  };
}

export type LarkMessageIgnoreReason =
  | "malformed_event"
  | "missing_sender_open_id"
  | "bot_self_message"
  | "unsupported_chat_type"
  | "missing_message_id";

export type LarkMessageChangeIgnoreReason = "malformed_event" | "missing_message_id";

export type LarkBotMenuIgnoreReason =
  | "malformed_event"
  | "missing_event_key"
  | "unsupported_event_key"
  | "missing_operator_open_id";

export interface NormalizeLarkMessageOptions {
  botOpenId?: string;
}

export type NormalizeLarkMessageResult =
  | { kind: "message"; message: IncomingLarkMessage }
  | { kind: "ignored"; reason: LarkMessageIgnoreReason; raw: unknown };

export type NormalizeLarkMessageRecallResult =
  | { kind: "recall"; recall: IncomingLarkMessageRecall }
  | { kind: "ignored"; reason: LarkMessageChangeIgnoreReason; raw: unknown };

export type NormalizeLarkBotMenuResult =
  | { kind: "bot_menu"; action: IncomingLarkBotMenuAction }
  | { kind: "ignored"; reason: LarkBotMenuIgnoreReason; raw: unknown };

export function normalizeIncomingLarkMessage(
  raw: unknown,
  options: NormalizeLarkMessageOptions = {}
): IncomingLarkMessage | null {
  const result = normalizeIncomingLarkMessageWithReason(raw, options);
  return result.kind === "message" ? result.message : null;
}

export function normalizeIncomingLarkMessageWithReason(
  raw: unknown,
  options: NormalizeLarkMessageOptions = {}
): NormalizeLarkMessageResult {
  const event = unwrapReceiveEvent(raw);
  if (!isRecord(event) || !isRecord(event.sender) || !isRecord(event.message)) {
    return ignored("malformed_event", raw);
  }

  const sender = event.sender;
  const senderId = isRecord(sender.sender_id) ? sender.sender_id : {};
  const senderOpenId = stringValue(senderId.open_id);
  if (!senderOpenId) {
    return ignored("missing_sender_open_id", raw);
  }

  const senderType = stringValue(sender.sender_type)?.toLowerCase();
  if (senderType === "app" || senderType === "bot" || senderOpenId === options.botOpenId) {
    return ignored("bot_self_message", raw);
  }
  const senderName = firstStringValue(
    sender.name,
    sender.sender_name,
    sender.display_name,
    sender.sender_display_name
  );

  const message = event.message;
  const chatType = normalizeChatType(stringValue(message.chat_type));
  if (!chatType) {
    return ignored("unsupported_chat_type", raw);
  }

  const messageType = stringValue(message.message_type) ?? "unknown";
  const messageId = stringValue(message.message_id);
  if (!messageId) {
    return ignored("missing_message_id", raw);
  }
  const chatId = chatType === "p2p" ? senderOpenId : stringValue(message.chat_id);
  if (!chatId) {
    return ignored("malformed_event", raw);
  }

  const content = normalizeMessageContent(messageType, message.content);
  const resources = content.resources;
  const shouldUseRaw = content.text === null || (content.text.length === 0 && resources.length === 0);
  const text = shouldUseRaw ? stringifyRawMessage(message) : (content.text ?? "");
  const rawForCodex = content.rawForCodex || shouldUseRaw;

  return {
    kind: "message",
    message: {
      eventId:
        stringValue(event.event_id) ??
        stringValue(event.uuid) ??
        stringValue(isRecord(raw) && isRecord(raw.header) ? raw.header.event_id : undefined) ??
        messageId,
      messageId,
      chatId,
      chatType,
      messageType,
      senderOpenId,
      senderName,
      larkGroupId: chatType === "p2p" ? undefined : chatId,
      larkThreadId: larkThreadIdForMessage(message, messageId, chatType),
      mentions: normalizeMentions(message.mentions),
      resources: resources.length > 0 ? resources : undefined,
      rawForCodex: rawForCodex ? true : undefined,
      text,
      createTime: parseEpochMs(message.create_time ?? event.create_time),
      raw
    }
  };
}

export function normalizeLarkBotMenuWithReason(raw: unknown): NormalizeLarkBotMenuResult {
  if (!isRecord(raw)) {
    return ignoredBotMenu("malformed_event", raw);
  }

  const header = eventHeader(raw);
  const event = eventPayload(raw);
  const eventKey = stringValue(event.event_key);
  if (!eventKey) {
    return ignoredBotMenu("missing_event_key", raw);
  }

  const action = botMenuActionForEventKey(eventKey);
  if (!action) {
    return ignoredBotMenu("unsupported_event_key", raw);
  }

  const operator = isRecord(event.operator) ? event.operator : {};
  const operatorId = isRecord(operator.operator_id) ? operator.operator_id : {};
  const operatorOpenId = stringValue(operatorId.open_id);
  if (!operatorOpenId) {
    return ignoredBotMenu("missing_operator_open_id", raw);
  }

  return {
    kind: "bot_menu",
    action: {
      eventId: firstStringValue(header.event_id, raw.event_id, raw.uuid, `${eventKey}:${operatorOpenId}`) ?? `${eventKey}:${operatorOpenId}`,
      eventKey,
      action,
      operatorOpenId,
      operatorName: stringValue(operator.operator_name),
      timestamp: parseEpochMs(event.timestamp ?? header.create_time ?? raw.create_time),
      raw
    }
  };
}

export function normalizeLarkMessageRecallWithReason(raw: unknown): NormalizeLarkMessageRecallResult {
  if (!isRecord(raw)) {
    return ignoredMessageChange("malformed_event", raw);
  }

  const header = eventHeader(raw);
  const event = eventPayload(raw);
  const messageId = stringValue(event.message_id);
  if (!messageId) {
    return ignoredMessageChange("missing_message_id", raw);
  }

  return {
    kind: "recall",
    recall: {
      eventId: firstStringValue(header.event_id, raw.event_id, raw.uuid, messageId) ?? messageId,
      messageId,
      chatId: stringValue(event.chat_id) ?? chatIdFromChatInfo(event.chat_info),
      recallTime: parseEpochMs(event.recall_time),
      raw
    }
  };
}

interface NormalizedMessageContent {
  text: string | null;
  resources: IncomingLarkMessageResource[];
  rawForCodex: boolean;
}

function normalizeMessageContent(messageType: string, content: unknown): NormalizedMessageContent {
  if (messageType === "text") {
    return {
      text: normalizeTextContent(content),
      resources: [],
      rawForCodex: false
    };
  }

  if (messageType === "post") {
    const post = normalizePostContent(content);
    if (post) {
      return {
        ...post,
        rawForCodex: false
      };
    }
  }

  const resources = extractMessageResources(messageType, content);
  return {
    text: resources.length === 0 ? null : fallbackResourceText(resources),
    resources,
    rawForCodex: resources.length === 0
  };
}

function stringifyRawMessage(message: Record<string, unknown>): string {
  try {
    return JSON.stringify(message) ?? "";
  } catch {
    return String(message);
  }
}

function fallbackResourceText(resources: IncomingLarkMessageResource[]): string | null {
  if (resources.length === 0) {
    return null;
  }
  return resources
    .map((resource) => `收到一个文件，资源 key：${resource.fileKey}`)
    .join("\n");
}

interface NormalizedPostContent {
  text: string;
  resources: IncomingLarkMessageResource[];
}

function normalizePostContent(content: unknown): NormalizedPostContent | null {
  const parsed = parseContentObject(content);
  const post = parsed ? getPostContent(parsed) : null;
  if (!post) {
    return null;
  }

  const resources: IncomingLarkMessageResource[] = [];
  const parts: string[] = [];
  const title = stringValue(post.title)?.trim();
  if (title) {
    parts.push(`# ${escapeMarkdownText(title)}`);
  }

  const paragraphs = Array.isArray(post.content) ? post.content : [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) {
      continue;
    }
    const rendered = renderPostParagraph(paragraph, resources).trim();
    if (rendered) {
      parts.push(rendered);
    }
  }

  return {
    text: parts.join("\n\n"),
    resources
  };
}

function getPostContent(content: Record<string, unknown>): Record<string, unknown> | null {
  if (Array.isArray(content.content)) {
    return content;
  }
  for (const locale of ["zh_cn", "en_us", "ja_jp"] as const) {
    const value = content[locale];
    if (isRecord(value) && Array.isArray(value.content)) {
      return value;
    }
  }
  for (const value of Object.values(content)) {
    if (isRecord(value) && Array.isArray(value.content)) {
      return value;
    }
  }
  return null;
}

function renderPostParagraph(paragraph: unknown[], resources: IncomingLarkMessageResource[]): string {
  return paragraph.map((node) => renderPostNode(node, resources)).join("");
}

function renderPostNode(node: unknown, resources: IncomingLarkMessageResource[]): string {
  if (!isRecord(node)) {
    return "";
  }

  const tag = stringValue(node.tag);
  if (tag === "text") {
    return renderStyledMarkdownText(stringValue(node.text) ?? "", node.style);
  }
  if (tag === "a") {
    const text = renderStyledMarkdownText(stringValue(node.text) ?? stringValue(node.href) ?? "", node.style);
    const href = stringValue(node.href);
    return href ? `[${text}](${escapeMarkdownUrl(href)})` : text;
  }
  if (tag === "at") {
    const displayName = stringValue(node.user_name) ?? stringValue(node.user_id) ?? "unknown";
    return renderStyledMarkdownText(`@${displayName}`, node.style);
  }
  if (tag === "img") {
    const imageKey = stringValue(node.image_key);
    if (!imageKey) {
      return renderUnsupportedPostNode(node);
    }
    const placeholder = resourcePlaceholder(resources.length);
    resources.push({
      resourceType: "image",
      fileKey: imageKey,
      codexTag: "img",
      textPlaceholder: placeholder
    });
    return placeholder;
  }
  if (tag === "media") {
    const fileKey = stringValue(node.file_key);
    if (!fileKey) {
      return renderUnsupportedPostNode(node);
    }
    const placeholder = resourcePlaceholder(resources.length);
    resources.push({
      resourceType: "file",
      fileKey,
      codexTag: "video",
      textPlaceholder: placeholder
    });
    return placeholder;
  }
  if (tag === "emotion") {
    const emojiType = stringValue(node.emoji_type);
    return emojiType ? `:${escapeMarkdownText(emojiType)}:` : "";
  }
  if (tag === "hr") {
    return "---";
  }
  if (tag === "code_block") {
    const language = (stringValue(node.language) ?? "").toLowerCase();
    return `\`\`\`${language}\n${stringValue(node.text) ?? ""}\n\`\`\``;
  }
  if (tag === "md") {
    return stringValue(node.text) ?? "";
  }
  return renderUnsupportedPostNode(node);
}

function renderStyledMarkdownText(text: string, style: unknown): string {
  let rendered = escapeMarkdownText(text);
  const styles = Array.isArray(style) ? style.filter((value): value is string => typeof value === "string") : [];
  if (styles.includes("underline")) {
    rendered = `<u>${rendered}</u>`;
  }
  if (styles.includes("lineThrough")) {
    rendered = `~~${rendered}~~`;
  }
  if (styles.includes("bold") && styles.includes("italic")) {
    return `***${rendered}***`;
  }
  if (styles.includes("bold")) {
    rendered = `**${rendered}**`;
  }
  if (styles.includes("italic")) {
    rendered = `*${rendered}*`;
  }
  return rendered;
}

function renderUnsupportedPostNode(node: Record<string, unknown>): string {
  try {
    return `\`${JSON.stringify(node).replaceAll("`", "\\`")}\``;
  } catch {
    return "";
  }
}

function resourcePlaceholder(index: number): string {
  return `{{TWINNY_LARK_RESOURCE_${index}}}`;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+.!|>~-])/g, "\\$1");
}

function escapeMarkdownUrl(value: string): string {
  return value.replace(/\)/g, "%29");
}

function extractMessageResources(messageType: string | undefined, content: unknown): IncomingLarkMessageResource[] {
  const parsed = parseContentObject(content);
  if (!parsed) {
    return [];
  }
  if (messageType === "image") {
    const imageKey = stringValue(parsed.image_key);
    return imageKey ? [{ resourceType: "image", fileKey: imageKey }] : [];
  }
  if (messageType === "file" || messageType === "audio" || messageType === "media" || messageType === "video") {
    const fileKey = stringValue(parsed.file_key);
    return fileKey
      ? [
          {
            resourceType: "file",
            fileKey,
            fileName: stringValue(parsed.file_name)
          }
        ]
      : [];
  }
  return [];
}

function parseContentObject(content: unknown): Record<string, unknown> | null {
  if (isRecord(content)) {
    return content;
  }
  if (typeof content !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeTextContent(content: unknown): string | null {
  if (typeof content !== "string") {
    if (isRecord(content) && typeof content.text === "string") {
      return content.text;
    }
    return null;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && typeof parsed.text === "string") {
      return parsed.text;
    }
  } catch {
    // Some event sources emit already-decoded text; raw SDK events emit JSON strings.
  }
  return content;
}

function unwrapReceiveEvent(raw: unknown): unknown {
  if (isRecord(raw) && isRecord(raw.event)) {
    return raw.event;
  }
  return raw;
}

function normalizeChatType(chatType: string | undefined): "p2p" | "group" | "topic_group" | undefined {
  if (!chatType) {
    return undefined;
  }
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
      return undefined;
  }
}

function larkThreadIdForMessage(
  message: Record<string, unknown>,
  messageId: string,
  chatType: "p2p" | "group" | "topic_group"
): string | undefined {
  const explicitThreadId = firstStringValue(message.thread_id);
  if (explicitThreadId) {
    return explicitThreadId;
  }
  if (chatType !== "topic_group") {
    return undefined;
  }
  return firstStringValue(message.root_id, message.parent_id, messageId) ?? messageId;
}

function normalizeMentions(value: unknown): IncomingLarkMention[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const mentions: IncomingLarkMention[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const key = stringValue(item.key);
    const id = isRecord(item.id) ? item.id : {};
    const openId = stringValue(id.open_id) ?? stringValue(item.open_id);
    const userId = stringValue(id.user_id) ?? stringValue(item.user_id);
    const unionId = stringValue(id.union_id) ?? stringValue(item.union_id);
    const name = stringValue(item.name);
    if (!key && !openId && !userId && !unionId) {
      continue;
    }
    mentions.push({
      key: key ?? "",
      openId,
      userId,
      unionId,
      name
    });
  }
  return mentions.length > 0 ? mentions : undefined;
}

function parseEpochMs(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function ignored(reason: LarkMessageIgnoreReason, raw: unknown): NormalizeLarkMessageResult {
  return { kind: "ignored", reason, raw };
}

function ignoredMessageChange(
  reason: LarkMessageChangeIgnoreReason,
  raw: unknown
): { kind: "ignored"; reason: LarkMessageChangeIgnoreReason; raw: unknown } {
  return { kind: "ignored", reason, raw };
}

function ignoredBotMenu(reason: LarkBotMenuIgnoreReason, raw: unknown): NormalizeLarkBotMenuResult {
  return { kind: "ignored", reason, raw };
}

function botMenuActionForEventKey(eventKey: string): IncomingLarkBotMenuAction["action"] | undefined {
  switch (eventKey.trim().toLowerCase()) {
    case "stop":
    case "new":
    case "queue":
    case "status":
    case "help":
      return eventKey.trim().toLowerCase() as IncomingLarkBotMenuAction["action"];
    default:
      return undefined;
  }
}

function eventPayload(raw: Record<string, unknown>): Record<string, unknown> {
  return isRecord(raw.event) ? raw.event : raw;
}

function eventHeader(raw: Record<string, unknown>): Record<string, unknown> {
  return isRecord(raw.header) ? raw.header : {};
}

function chatIdFromChatInfo(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return stringValue(value.chat_id);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    const string = stringValue(value);
    if (string) {
      return string;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
