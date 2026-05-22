export type RoleName = "owner" | "guest";

export type ConversationType = "p2p" | "group" | "topic_group";

export type LarkChatMode = "group" | "topic";

export type LarkGroupMessageType = "chat" | "thread";

export type ConversationResponseMode = "all" | "at" | "none";

export type AgentMessagePhase = "commentary" | "final_answer";

export type LarkMessageRedactionStrategy = "mask" | "whitespace" | "none";

export type CodexThreadMode = "default" | "plan";

export type CodexThreadStatus = "idle" | "working" | "waiting";

export type CodexThreadGoalStatus =
  | "none"
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface CodexAgentMessage {
  id: string;
  text: string;
  phase?: AgentMessagePhase | null;
}

export interface CodexImageGeneration {
  id: string;
  status?: string;
  savedPath?: string;
  revisedPrompt?: string;
  result?: string;
}

export interface CodexThreadNameUpdate {
  threadId: string;
  name: string;
}

export type LarkMessageRouteKind =
  | "message"
  | "side_message"
  | "goal_message"
  | "steered_message"
  | "queued_message"
  | "control_message"
  | "card_action"
  | "menu_action";

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
export const DEFAULT_LARK_QUEUED_REACTION = "OneSecond";
export const DEFAULT_LARK_MAX_MESSAGE_AGE_SECONDS = 60;
export const DEFAULT_LARK_MESSAGE_REDACTION_STRATEGY: LarkMessageRedactionStrategy = "mask";

export interface LarkMessageRedactionConfig {
  email: LarkMessageRedactionStrategy;
  chinesePhoneNumber: LarkMessageRedactionStrategy;
}

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
  queuedReaction: string;
  maxMessageAgeSeconds: number;
  iconImageKey?: string;
  messageRedaction: LarkMessageRedactionConfig;
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
  larkAssetsFile: string;
  lockFile: string;
  logsDir: string;
}

export interface ConversationRecord {
  id: number;
  conversationKey: string;
  type: ConversationType;
  chatId: string;
  name: string;
  responseMode: ConversationResponseMode;
  role: RoleName;
  codexThreadId: string;
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
  responseMode?: ConversationResponseMode;
  role: RoleName;
  codexThreadId: string;
  workspace: string;
  roleCodexHome: string;
}

export interface CodexThreadRecord {
  id: number;
  codexThreadId: string;
  conversationKey: string;
  name: string;
  larkThreadId?: string;
  role: RoleName;
  mode: CodexThreadMode;
  status: CodexThreadStatus;
  goalStatus: CodexThreadGoalStatus;
  goalUpdatedAt?: number;
  forkedFromCodexThreadId?: string;
  forkedAt?: number;
  creatorOpenId?: string;
  cardMessageId?: string;
  codexThreadHasRollout: boolean;
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
  sideId?: number;
  agentCardMessageId?: string;
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
  larkRootMessageId?: string;
  larkParentMessageId?: string;
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
  formValue?: Record<string, unknown>;
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
  generatedImages?: CodexImageGeneration[];
}

export interface CodexRequestUserInputOption {
  label: string;
  description: string;
}

export interface CodexRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexRequestUserInputOption[] | null;
}

export interface CodexRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexRequestUserInputQuestion[];
}

export interface CodexRequestUserInputAnswer {
  answers: string[];
}

export interface CodexRequestUserInputResponse {
  answers: Record<string, CodexRequestUserInputAnswer | undefined>;
}

export interface CodexRequestUserInputRequest {
  requestId: string | number;
  params: CodexRequestUserInputParams;
}

export interface CodexPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface CodexPlanUpdate {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: CodexPlanStep[];
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
