export type RoleName = "owner" | "guest";

export type ConversationType = "p2p";

export type LarkMessageRouteKind = "message" | "steered_message" | "queued_message" | "control_message";

export type LarkMessageStatus = "queued" | "processing" | "completed" | "failed" | "cleared";

export const DEFAULT_LARK_WORKING_REACTION = "Typing";
export const DEFAULT_LARK_COMPLETED_REACTION = "DONE";
export const DEFAULT_LARK_MAX_MESSAGE_AGE_SECONDS = 60;

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
  role: RoleName;
  codexThreadId: string;
  codexThreadHasRollout?: boolean;
  workspace: string;
  roleCodexHome: string;
}

export interface UserRecord {
  id: number;
  larkUserId: string;
  name: string;
  role: RoleName;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
}

export interface CodexThreadRecord {
  id: number;
  codexThreadId: string;
  conversationKey: string;
  larkThreadId?: string;
  role: RoleName;
  forkedFromCodexThreadId?: string;
  forkedAt?: number;
  totalTokens: number;
  tokenUsageJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface LarkMessageRecord {
  id: number;
  larkMessageId: string;
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
  chatType: "p2p" | "group" | string;
  messageType: string;
  senderOpenId: string;
  senderName?: string;
  larkGroupId?: string;
  larkThreadId?: string;
  resources?: IncomingLarkMessageResource[];
  downloadedFiles?: DownloadedLarkFile[];
  text: string;
  createTime?: number;
  raw: unknown;
}

export interface IncomingLarkMessageResource {
  resourceType: "image" | "file";
  fileKey: string;
  fileName?: string;
}

export interface DownloadedLarkFile extends IncomingLarkMessageResource {
  path: string;
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
