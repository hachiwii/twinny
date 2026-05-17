export type RoleName = "owner" | "guest";

export type ConversationType = "p2p" | "group" | "topic_group";

export type LarkChatMode = "group" | "topic";

export type LarkGroupMessageType = "chat" | "thread";

export type ConversationResponseMode = "all" | "at" | "none";

export type AgentMessageMode = "plain" | "card";

export type AgentMessagePhase = "commentary" | "final_answer";

export interface CodexAgentMessage {
  id: string;
  text: string;
  phase?: AgentMessagePhase | null;
}

export type LarkMessageRouteKind = "message" | "steered_message" | "queued_message" | "control_message" | "card_action";

export type LarkMessageStatus =
  | "queued"
  | "recalled"
  | "processing"
  | "steered"
  | "completed"
  | "failed"
  | "interrupted"
  | "cleared";

export const DEFAULT_LARK_WORKING_REACTION = "Typing";
export const DEFAULT_LARK_COMPLETED_REACTION = "DONE";
export const DEFAULT_LARK_MAX_MESSAGE_AGE_SECONDS = 60;
export const DEFAULT_AGENT_MESSAGE_MODE: AgentMessageMode = "card";

export interface OwnerConfig {
  openId: string;
  userId?: string;
  displayName: string;
  tokenRef?: string;
  refreshTokenRef?: string;
}

export interface LarkConfig {
  appId: string;
  appSecretRef: string;
  eventKey: "im.message.receive_v1";
  identity: "bot";
  workingReaction: string;
  completedReaction: string;
  maxMessageAgeSeconds: number;
  agentMessageMode: AgentMessageMode;
  iconImageKey?: string;
  newSessionToolkitId?: string;
}

export interface CodexConfig {
  binary: string;
  appServerListen: "stdio://";
}

export interface RoleConfig {
  codexHome: string;
}

export interface TwinnyConfig {
  home: string;
  codex: CodexConfig;
  lark: LarkConfig;
  owner: OwnerConfig;
  roles: Record<RoleName, RoleConfig>;
}

export interface RuntimePaths {
  home: string;
  configFile: string;
  rolesDir: string;
  ownerCodexHome: string;
  guestCodexHome: string;
  sqliteDir: string;
  sqliteFile: string;
  workspacesDir: string;
  runtimeDir: string;
  lockFile: string;
  logsDir: string;
}

export interface ConversationRecord {
  id: number;
  conversationKey: string;
  type: ConversationType;
  chatId: string;
  name: string;
  chatMode?: LarkChatMode;
  responseMode: ConversationResponseMode;
  role: RoleName;
  codexThreadId: string;
  codexThreadHasRollout: boolean;
  workspace: string;
  roleCodexHome: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewConversationRecord {
  conversationKey: string;
  type: ConversationType;
  chatId: string;
  name: string;
  chatMode?: LarkChatMode;
  responseMode?: ConversationResponseMode;
  role: RoleName;
  codexThreadId: string;
  codexThreadHasRollout?: boolean;
  workspace: string;
  roleCodexHome: string;
}

export interface CodexThreadRecord {
  id: number;
  codexThreadId: string;
  conversationKey: string;
  larkThreadId?: string;
  role: RoleName;
  forkedFromCodexThreadId?: string;
  forkedAt?: number;
  creatorOpenId?: string;
  cardMessageId?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  contextTokens: number;
  contextWindow: number;
  tokenUsageJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface LarkMessageRecord {
  id: number;
  larkMessageId?: string;
  eventId: string;
  larkUserId: string;
  larkGroupId?: string;
  larkThreadId?: string;
  conversationKey?: string;
  codexThreadId?: string;
  codexTurnId?: string;
  routeKind: LarkMessageRouteKind;
  status: LarkMessageStatus;
  text: string;
  larkCreateTime?: number;
  receivedAt: number;
  updatedAt: number;
  processingStartedAt?: number;
  completedAt?: number;
  failedAt?: number;
  clearedAt?: number;
  rawEventJson?: string;
}

export interface IncomingLarkMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group" | "topic_group" | string;
  messageType: string;
  senderOpenId: string;
  senderName?: string;
  chatName?: string;
  larkGroupId?: string;
  larkThreadId?: string;
  mentions?: IncomingLarkMention[];
  resources?: IncomingLarkMessageResource[];
  downloadedFiles?: DownloadedLarkFile[];
  rawForCodex?: boolean;
  text: string;
  createTime?: number;
  raw: unknown;
}

export interface IncomingLarkMention {
  key: string;
  openId?: string;
  userId?: string;
  unionId?: string;
  name?: string;
}

export interface IncomingLarkMessageRecall {
  eventId: string;
  messageId: string;
  chatId?: string;
  recallTime?: number;
  raw: unknown;
}

export type LarkBotMenuActionKey = "stop" | "new" | "queue" | "status" | "help" | "new_session";

export interface IncomingLarkBotMenuAction {
  eventId: string;
  eventKey: string;
  action: LarkBotMenuActionKey;
  operatorOpenId: string;
  operatorName?: string;
  chatId?: string;
  timestamp?: number;
  raw: unknown;
}

export interface IncomingLarkCardAction {
  eventId: string;
  operatorOpenId: string;
  openMessageId?: string;
  openChatId?: string;
  actionTag?: string;
  actionValue: Record<string, unknown>;
  raw: unknown;
}

export interface IncomingLarkMessageResource {
  resourceType: "image" | "file";
  fileKey: string;
  fileName?: string;
  codexTag?: "img" | "video" | "file";
  textPlaceholder?: string;
}

export interface DownloadedLarkFile extends IncomingLarkMessageResource {
  path: string;
  size: number;
  contentType?: string;
}

export interface LarkReactionHandle {
  messageId: string;
  reactionId: string;
}

export interface CodexTurnRequest {
  threadId: string;
  input: string;
  cwd: string;
  role: RoleName;
}

export interface CodexTurnResult {
  threadId: string;
  turnId?: string;
  text: string;
  status: "completed" | "failed" | "interrupted";
  error?: string;
  durationMs?: number;
}

export interface CodexThreadTokenUsageUpdate {
  threadId: string;
  turnId?: string;
  totalTokens: number;
  raw: unknown;
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface HealthSnapshot {
  ok: boolean;
  checks: HealthCheck[];
}
