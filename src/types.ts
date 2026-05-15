export type RoleName = "owner" | "guest";

export type ConversationType = "p2p";

export const DEFAULT_LARK_WORKING_REACTION = "Typing";

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

export interface IncomingLarkMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group" | string;
  messageType: string;
  senderOpenId: string;
  senderName?: string;
  text: string;
  createTime?: number;
  raw: unknown;
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

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface HealthSnapshot {
  ok: boolean;
  checks: HealthCheck[];
}
