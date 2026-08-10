import type {
  IncomingLarkBotAddedToChat,
  IncomingLarkBotMenuAction,
  IncomingLarkDocCommentAdd,
  IncomingLarkMention,
  IncomingLarkMessage,
  IncomingLarkMessageRecall,
  IncomingLarkMessageResource,
  IncomingLarkP2pChatCreate,
  LarkCommandTokenEncoding
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

export type LarkDocCommentIgnoreReason =
  | "malformed_event"
  | "missing_file"
  | "missing_comment_id"
  | "missing_sender_open_id";

export type LarkBotMenuIgnoreReason =
  | "malformed_event"
  | "missing_event_key"
  | "unsupported_event_key"
  | "missing_operator_open_id";

export type LarkP2pChatCreateIgnoreReason = "malformed_event" | "missing_user_open_id";

export type LarkBotAddedToChatIgnoreReason = "malformed_event" | "missing_chat_id";

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

export type NormalizeLarkDocCommentResult =
  | { kind: "doc_comment"; comment: IncomingLarkDocCommentAdd }
  | { kind: "ignored"; reason: LarkDocCommentIgnoreReason; raw: unknown };

export type NormalizeLarkP2pChatCreateResult =
  | { kind: "p2p_chat_create"; event: IncomingLarkP2pChatCreate }
  | { kind: "ignored"; reason: LarkP2pChatCreateIgnoreReason; raw: unknown };

export type NormalizeLarkBotAddedToChatResult =
  | { kind: "bot_added_to_chat"; event: IncomingLarkBotAddedToChat }
  | { kind: "ignored"; reason: LarkBotAddedToChatIgnoreReason; raw: unknown };

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
  if (senderOpenId === options.botOpenId) {
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

  const content = normalizeLarkMessageContent(messageType, message.content);
  const resources = content.resources;
  const shouldUseRaw = content.text === null || (content.text.length === 0 && resources.length === 0);
  const text = shouldUseRaw ? stringifyRawLarkMessageForCodex(message) : (content.text ?? "");
  const rawForCodex = content.rawForCodex || shouldUseRaw;
  const commandTokenEncoding = commandTokenEncodingForNormalizedMessage(event, messageType);

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
      senderType,
      larkGroupId: chatType === "p2p" ? undefined : chatId,
      larkThreadId: larkThreadIdForMessage(message, messageId, chatType),
      larkRootMessageId: firstStringValue(message.root_id),
      larkParentMessageId: firstStringValue(message.parent_id),
      mentions: normalizeMentions(message.mentions),
      resources: resources.length > 0 ? resources : undefined,
      rawForCodex: rawForCodex ? true : undefined,
      text,
      plainText: content.plainText,
      commandTokenEncoding,
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
      chatId: chatIdFromBotMenuEvent(event),
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

export function normalizeLarkDocCommentAddWithReason(raw: unknown): NormalizeLarkDocCommentResult {
  if (!isRecord(raw)) {
    return ignoredDocComment("malformed_event", raw);
  }

  const header = eventHeader(raw);
  const event = eventPayload(raw);
  const noticeMeta = isRecord(event.notice_meta) ? event.notice_meta : {};
  const fileType = firstStringValue(
    event.file_type,
    noticeMeta.file_type,
    getRecordValue(event.file, "file_type"),
    getRecordValue(event.file, "type"),
    event.obj_type
  );
  const fileToken = firstStringValue(
    event.file_token,
    noticeMeta.file_token,
    getRecordValue(event.file, "file_token"),
    getRecordValue(event.file, "token"),
    event.obj_token
  );
  if (!fileType || !fileToken) {
    return ignoredDocComment("missing_file", raw);
  }

  const comment = isRecord(event.comment) ? event.comment : {};
  const reply = isRecord(event.reply) ? event.reply : {};
  const noticeFromUser = isRecord(noticeMeta.from_user_id) ? noticeMeta.from_user_id : {};
  const commentId = firstStringValue(event.comment_id, comment.comment_id, comment.id);
  if (!commentId) {
    return ignoredDocComment("missing_comment_id", raw);
  }

  const senderOpenId = firstStringValue(
    getRecordValue(getRecordValue(event.operator, "operator_id"), "open_id"),
    getRecordValue(getRecordValue(event.sender, "sender_id"), "open_id"),
    noticeFromUser.open_id,
    event.user_id,
    reply.user_id,
    comment.user_id
  );
  if (!senderOpenId) {
    return ignoredDocComment("missing_sender_open_id", raw);
  }

  return {
    kind: "doc_comment",
    comment: {
      eventId: firstStringValue(header.event_id, raw.event_id, raw.uuid, `${fileType}:${fileToken}:${commentId}`) ?? `${fileType}:${fileToken}:${commentId}`,
      fileType,
      fileToken,
      commentId,
      replyId: firstStringValue(event.reply_id, reply.reply_id, reply.id),
      senderOpenId,
      senderName: firstStringValue(
        event.operator_name,
        event.sender_name,
        getRecordValue(event.operator, "name"),
        getRecordValue(event.sender, "name"),
        reply.user_name,
        comment.user_name
      ),
      isMentioned: booleanValue(event.is_mentioned) || booleanValue(reply.is_mentioned) || booleanValue(comment.is_mentioned),
      createTime: parseEpochMs(event.create_time ?? reply.create_time ?? comment.create_time ?? header.create_time),
      raw
    }
  };
}

export function normalizeLarkP2pChatCreateWithReason(raw: unknown): NormalizeLarkP2pChatCreateResult {
  if (!isRecord(raw)) {
    return ignoredP2pChatCreate("malformed_event", raw);
  }

  const header = eventHeader(raw);
  const event = eventPayload(raw);
  const userOpenId = firstStringValue(
    event.open_id,
    event.user_open_id,
    event.user_id,
    getRecordValue(event.user, "open_id"),
    getRecordValue(event.user_id, "open_id"),
    getRecordValue(event.sender, "open_id"),
    event.sender_id,
    getRecordValue(event.sender_id, "open_id"),
    getRecordValue(event.operator, "open_id"),
    event.operator_id,
    getRecordValue(event.operator_id, "open_id")
  );
  if (!userOpenId) {
    return ignoredP2pChatCreate("missing_user_open_id", raw);
  }

  return {
    kind: "p2p_chat_create",
    event: {
      eventId: firstStringValue(header.event_id, raw.event_id, raw.uuid, `${userOpenId}:p2p_chat_create`) ?? `${userOpenId}:p2p_chat_create`,
      userOpenId,
      operatorOpenId: firstStringValue(
        getRecordValue(event.operator, "open_id"),
        getRecordValue(event.operator_id, "open_id"),
        event.operator_open_id
      ),
      chatId: firstStringValue(event.chat_id, event.open_chat_id),
      chatName: firstStringValue(event.name, event.chat_name),
      createTime: parseEventEpochMs(event.ts ?? event.create_time ?? header.create_time ?? raw.ts ?? raw.create_time),
      raw
    }
  };
}

export function normalizeLarkBotAddedToChatWithReason(raw: unknown): NormalizeLarkBotAddedToChatResult {
  if (!isRecord(raw)) {
    return ignoredBotAddedToChat("malformed_event", raw);
  }

  const header = eventHeader(raw);
  const event = eventPayload(raw);
  const chatId = firstStringValue(event.chat_id, event.open_chat_id);
  if (!chatId) {
    return ignoredBotAddedToChat("missing_chat_id", raw);
  }

  return {
    kind: "bot_added_to_chat",
    event: {
      eventId: firstStringValue(header.event_id, raw.event_id, raw.uuid, `${chatId}:bot_added`) ?? `${chatId}:bot_added`,
      chatId,
      chatName: firstStringValue(event.name, event.chat_name),
      operatorOpenId: firstStringValue(
        getRecordValue(event.operator_id, "open_id"),
        getRecordValue(event.operator, "open_id"),
        event.operator_open_id
      ),
      createTime: parseEventEpochMs(event.create_time ?? header.create_time ?? raw.create_time),
      raw
    }
  };
}

export interface NormalizedLarkMessageContent {
  text: string | null;
  plainText?: string;
  resources: IncomingLarkMessageResource[];
  rawForCodex: boolean;
}

export function normalizeLarkMessageContent(messageType: string, content: unknown): NormalizedLarkMessageContent {
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

  if (messageType === "interactive") {
    const card = normalizeInteractiveCardContent(content);
    if (card) {
      return {
        ...card,
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

export function stringifyRawLarkMessageForCodex(message: Record<string, unknown>): string {
  const body = isRecord(message.body) ? message.body : {};
  const compact = {
    message_type: stringValue(message.message_type) ?? stringValue(message.msg_type) ?? "unknown",
    content: message.content ?? body.content ?? null
  };
  try {
    return JSON.stringify(compact) ?? "";
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
  plainText?: string;
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
  const plainParts: string[] = [];
  const title = stringValue(post.title)?.trim();
  if (title) {
    parts.push(`# ${escapeMarkdownText(title)}`);
    plainParts.push(title);
  }

  const paragraphs = Array.isArray(post.content) ? post.content : [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) {
      continue;
    }
    const rendered = renderPostParagraph(paragraph, resources);
    const text = rendered.text.trim();
    const plainText = rendered.plainText.trim();
    if (text) {
      parts.push(text);
    }
    if (plainText) {
      plainParts.push(plainText);
    }
  }

  return {
    text: parts.join("\n\n"),
    plainText: plainParts.join("\n\n"),
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

function normalizeInteractiveCardContent(content: unknown): NormalizedPostContent | null {
  const resolved = resolveInteractiveCardContent(content);
  if (!resolved) {
    return null;
  }

  const resources: IncomingLarkMessageResource[] = [];
  const attributes: Array<[string, string]> = [];
  const header = isRecord(resolved.header) ? resolved.header : {};
  const title = cardHeaderTextContent(header, "title");
  const subtitle = cardHeaderTextContent(header, "subtitle");
  if (title) {
    attributes.push(["title", title]);
  }
  if (subtitle) {
    attributes.push(["subtitle", subtitle]);
  }

  const bodyParts: string[] = [];
  const body = isRecord(resolved.body) ? resolved.body : {};
  renderCardElements(cardChildElements(body), resources, bodyParts);

  const openTag = attributes.length > 0
    ? `<card ${attributes.map(([name, value]) => `${name}="${escapeXmlAttribute(value)}"`).join(" ")}>`
    : "<card>";
  return {
    text: [openTag, ...bodyParts, "</card>"].join("\n"),
    resources
  };
}

function resolveInteractiveCardContent(content: unknown): Record<string, unknown> | null {
  const card = parseContentObject(content);
  if (!card) {
    return null;
  }
  if (isJson2InteractiveCard(card)) {
    return card;
  }

  const userDsl = parseContentObject(card.user_dsl);
  if (userDsl && isJson2InteractiveCard(userDsl)) {
    return userDsl;
  }

  return null;
}

function isJson2InteractiveCard(card: Record<string, unknown>): boolean {
  return stringValue(card.schema) === "2.0";
}

function renderCardElements(
  elements: unknown,
  resources: IncomingLarkMessageResource[],
  parts: string[]
): void {
  if (!Array.isArray(elements)) {
    return;
  }
  for (const element of elements) {
    renderCardElement(element, resources, parts);
  }
}

function renderCardElement(
  element: unknown,
  resources: IncomingLarkMessageResource[],
  parts: string[]
): void {
  if (!isRecord(element)) {
    return;
  }

  const tag = stringValue(element.tag);
  if (tag === "markdown") {
    pushNonEmpty(parts, cardMarkdownContent(element));
    return;
  }
  if (tag === "div") {
    pushNonEmpty(parts, cardTextContent(element.text));
    return;
  }
  if (tag === "plain_text") {
    pushNonEmpty(parts, cardTextContent(element));
    return;
  }
  if (tag === "img") {
    const imageKey = cardImageKey(element);
    if (imageKey) {
      const placeholder = resourcePlaceholder(resources.length);
      resources.push({
        resourceType: "image",
        fileKey: imageKey,
        codexTag: "file",
        textPlaceholder: placeholder
      });
      parts.push(placeholder);
    }
    return;
  }
  if (tag === "media") {
    const fileKey = stringValue(element.file_key);
    if (fileKey) {
      const placeholder = resourcePlaceholder(resources.length);
      resources.push({
        resourceType: "file",
        fileKey,
        codexTag: "file",
        textPlaceholder: placeholder
      });
      parts.push(placeholder);
    }
    return;
  }
  if (isDiscardedCardElementTag(tag)) {
    return;
  }
  if (tag === "collapsible_panel") {
    if (isRecord(element.header)) {
      pushNonEmpty(parts, cardHeaderTextContent(element.header, "title"));
    }
    renderCardElements(cardChildElements(element), resources, parts);
    return;
  }
  if (tag === "column_set") {
    renderCardColumns(element.columns, resources, parts);
    return;
  }
  if (isCardContainerTag(tag)) {
    renderCardElements(cardChildElements(element), resources, parts);
  }
}

function renderCardColumns(
  columns: unknown,
  resources: IncomingLarkMessageResource[],
  parts: string[]
): void {
  if (!Array.isArray(columns)) {
    return;
  }
  for (const column of columns) {
    if (isRecord(column)) {
      renderCardElements(cardChildElements(column), resources, parts);
    }
  }
}

function cardMarkdownContent(element: Record<string, unknown>): string | undefined {
  return stringValue(element.content);
}

function cardHeaderTextContent(header: Record<string, unknown>, key: "title" | "subtitle"): string | undefined {
  return cardTextContent(header[key]);
}

function cardChildElements(element: Record<string, unknown>): unknown {
  return element.elements;
}

function cardTextContent(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return stringValue(value.content);
}

function cardImageKey(element: Record<string, unknown>): string | undefined {
  return stringValue(element.img_key) ?? stringValue(element.image_key);
}

function pushNonEmpty(parts: string[], value: string | undefined): void {
  if (value !== undefined && value.trim() !== "") {
    parts.push(value);
  }
}

function isCardContainerTag(tag: string | undefined): boolean {
  return tag === "column" || tag === "form" || tag === "interactive_container";
}

function isDiscardedCardElementTag(tag: string | undefined): boolean {
  return tag === "button" ||
    tag === "select_static" ||
    tag === "multi_select_static" ||
    tag === "select_person" ||
    tag === "multi_select_person" ||
    tag === "input" ||
    tag === "chart" ||
    tag === "date_picker" ||
    tag === "picker_time" ||
    tag === "picker_datetime" ||
    tag === "checker" ||
    tag === "overflow" ||
    tag === "table";
}

function renderPostParagraph(
  paragraph: unknown[],
  resources: IncomingLarkMessageResource[]
): { text: string; plainText: string } {
  const nodes = paragraph.map((node) => renderPostNode(node, resources));
  return {
    text: nodes.map((node) => node.text).join(""),
    plainText: nodes.map((node) => node.plainText).join("")
  };
}

function renderPostNode(
  node: unknown,
  resources: IncomingLarkMessageResource[]
): { text: string; plainText: string } {
  if (!isRecord(node)) {
    return { text: "", plainText: "" };
  }

  const tag = stringValue(node.tag);
  if (tag === "text") {
    const plainText = stringValue(node.text) ?? "";
    return { text: renderStyledMarkdownText(plainText, node.style), plainText };
  }
  if (tag === "a") {
    const plainText = stringValue(node.text) ?? stringValue(node.href) ?? "";
    const text = renderStyledMarkdownText(plainText, node.style);
    const href = stringValue(node.href);
    return { text: href ? `[${text}](${escapeMarkdownUrl(href)})` : text, plainText };
  }
  if (tag === "at") {
    const displayName = stringValue(node.user_name) ?? stringValue(node.user_id) ?? "unknown";
    const plainText = `@${displayName}`;
    return { text: renderStyledMarkdownText(plainText, node.style), plainText };
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
    return { text: placeholder, plainText: placeholder };
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
    return { text: placeholder, plainText: placeholder };
  }
  if (tag === "emotion") {
    const emojiType = stringValue(node.emoji_type);
    return emojiType
      ? { text: `:${escapeMarkdownText(emojiType)}:`, plainText: `:${emojiType}:` }
      : { text: "", plainText: "" };
  }
  if (tag === "hr") {
    return { text: "---", plainText: "---" };
  }
  if (tag === "code_block") {
    const language = (stringValue(node.language) ?? "").toLowerCase();
    const plainText = stringValue(node.text) ?? "";
    return { text: `\`\`\`${language}\n${plainText}\n\`\`\``, plainText };
  }
  if (tag === "md") {
    const text = stringValue(node.text) ?? "";
    return { text, plainText: text };
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

function renderUnsupportedPostNode(node: Record<string, unknown>): { text: string; plainText: string } {
  try {
    const plainText = JSON.stringify(node);
    return { text: `\`${plainText.replaceAll("`", "\\`")}\``, plainText };
  } catch {
    return { text: "", plainText: "" };
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

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

function commandTokenEncodingForNormalizedMessage(
  event: Record<string, unknown>,
  messageType: string
): LarkCommandTokenEncoding {
  const twinny = isRecord(event.twinny) ? event.twinny : {};
  const syntheticEncoding = stringValue(twinny.command_token_encoding);
  if (syntheticEncoding === "normalized_post_markdown") {
    return syntheticEncoding;
  }
  return messageType.trim().toLowerCase() === "post" ? "normalized_post_markdown" : "plain";
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

function parseEventEpochMs(value: unknown): number | undefined {
  const parsed = parseEpochMs(value);
  if (parsed === undefined) {
    return undefined;
  }
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
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

function ignoredDocComment(reason: LarkDocCommentIgnoreReason, raw: unknown): NormalizeLarkDocCommentResult {
  return { kind: "ignored", reason, raw };
}

function ignoredP2pChatCreate(reason: LarkP2pChatCreateIgnoreReason, raw: unknown): NormalizeLarkP2pChatCreateResult {
  return { kind: "ignored", reason, raw };
}

function ignoredBotAddedToChat(reason: LarkBotAddedToChatIgnoreReason, raw: unknown): NormalizeLarkBotAddedToChatResult {
  return { kind: "ignored", reason, raw };
}

function botMenuActionForEventKey(eventKey: string): IncomingLarkBotMenuAction["action"] | undefined {
  const normalized = eventKey.trim().toLowerCase();
  switch (normalized) {
    case "stop":
    case "new":
    case "queue":
    case "status":
    case "help":
      return normalized as IncomingLarkBotMenuAction["action"];
    case "new_session":
    case "new-session":
    case "new session":
    case "new_conversation":
    case "new-conversation":
      return "new_session";
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

function getRecordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function chatIdFromChatInfo(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return stringValue(value.chat_id);
}

function chatIdFromBotMenuEvent(event: Record<string, unknown>): string | undefined {
  return firstStringValue(
    event.chat_id,
    event.open_chat_id,
    isRecord(event.chat) ? event.chat.chat_id : undefined,
    isRecord(event.chat) ? event.chat.open_chat_id : undefined,
    chatIdFromChatInfo(event.chat_info),
    isRecord(event.operator) ? event.operator.chat_id : undefined,
    isRecord(event.operator) ? event.operator.open_chat_id : undefined
  );
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

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
