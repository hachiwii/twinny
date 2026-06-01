export type ProfileName = string;
export type UserIdentity = "owner" | "guest";

export const HOST_PROFILE_NAME = "host";
export const GUEST_PROFILE_NAME = "guest";
export const NONE_PROFILE_NAME = "none";

export type ConversationType = "p2p" | "group" | "topic_group";

export type LarkChatMode = "group" | "topic";

export type LarkGroupMessageType = "chat" | "thread";

export type LarkBrand = "feishu" | "lark";

export type ConversationResponseMode = "all" | "all_at" | "owner" | "owner_at" | "none";

export type AgentMessagePhase = "commentary" | "final_answer";

export type LarkMessageRedactionStrategy = "mask" | "whitespace" | "none";

export type CodexThreadMode = "default" | "plan";

export type CodexThreadStatus = "idle" | "working" | "waiting";

export type CodexThreadCategory = "main" | "thread" | "previous_main";
export type CodexThreadCreateMethod = "init_main" | "new_main" | "fresh" | "fork" | "resume";

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

export interface CodexErrorNotification {
  threadId?: string;
  turnId?: string;
  message: string;
  willRetry: boolean | null;
  codexErrorInfo: string | null;
  additionalDetails: string | null;
  raw: unknown;
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
  | "thread_message"
  | "cron_message"
  | "doc_comment"
  | "doc_comment_reply_steer"
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

export const DEFAULT_LARK_WORKING_REACTION = "JubilantRabbit";
export const DEFAULT_LARK_COMPLETED_REACTION = "DONE";
export const DEFAULT_LARK_QUEUED_REACTION = "OneSecond";
export const DEFAULT_LARK_MAX_MESSAGE_AGE_SECONDS = 60;
export const DEFAULT_LARK_MESSAGE_REDACTION_STRATEGY: LarkMessageRedactionStrategy = "mask";
export const DEFAULT_CONVERSATION_WORKSPACE_TEMPLATE = "{{twinny_home}}/workspaces/{{conversation_key}}";

export interface LarkMessageRedactionConfig {
  email: LarkMessageRedactionStrategy;
  chinesePhoneNumber: LarkMessageRedactionStrategy;
}

export interface OwnerConfig {
  openId: string;
  userId?: string;
  displayName: string;
}

export interface TwinnyAuthFile {
  larkAppId: string;
  larkAppSecret?: string;
  larkBrand: LarkBrand;
  ownerOpenId: string;
  displayName: string;
}

export interface TwinnyHomeIdentity {
  random: string;
  telemetryHashSalt: string;
  keychainAccounts: {
    larkAppSecret: string;
  };
}

export interface LarkConfig {
  workingReaction: string;
  completedReaction: string;
  queuedReaction: string;
  maxMessageAgeSeconds: number;
  messageRedaction: LarkMessageRedactionConfig;
}

export interface CodexConfig {
  binary: string;
  masqueradeAsCodexCli: boolean;
}

export interface ProfileConfig {
  codexHome: string;
  defaultModel?: string;
  defaultEffort?: string;
}

export interface PermissionsConfig {
  p2pDefaultProfile: ProfileName;
  p2pDefaultWorkspace: string;
  groupDefaultProfile: ProfileName;
  groupDefaultMode: ConversationResponseMode;
  groupDefaultWorkspace: string;
}

export interface TelemetryConfig {
  enabled: boolean;
  posthogProjectToken: string;
  posthogHost: string;
}

export interface LarkCliProfileConfig {
  profileName: string;
}

export type LaunchdServiceMode = "gui" | "daemon";

export interface LaunchdServiceConfig {
  mode: LaunchdServiceMode;
  userName?: string;
}

export interface ServiceConfig {
  launchd: LaunchdServiceConfig;
}

export interface TwinnyConfig {
  home: string;
  codex: CodexConfig;
  lark: LarkConfig;
  auth: TwinnyAuthFile;
  homeIdentity: TwinnyHomeIdentity;
  permissions: PermissionsConfig;
  service: ServiceConfig;
  telemetry?: TelemetryConfig;
  larkCliProfile?: LarkCliProfileConfig;
  owner: OwnerConfig;
  profiles: Record<ProfileName, ProfileConfig>;
}

export interface RuntimePaths {
  home: string;
  configFile: string;
  authFile: string;
  homeRandomFile: string;
  secretsFile: string;
  sqliteDir: string;
  sqliteFile: string;
  workspacesDir: string;
  runtimeDir: string;
  larkAssetsFile: string;
  larkCliProfileFile: string;
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
  profile: ProfileName;
  codexThreadId: string;
  workspace: string;
  profileCodexHome: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewConversationRecord {
  conversationKey: string;
  type: ConversationType;
  chatId: string;
  name: string;
  responseMode?: ConversationResponseMode;
  profile: ProfileName;
  codexThreadId: string;
  workspace: string;
  profileCodexHome: string;
}

export interface CodexThreadRecord {
  id: number;
  codexThreadId: string;
  conversationKey: string;
  workspace: string;
  name: string;
  larkThreadId?: string;
  profile: ProfileName;
  model?: string;
  effort?: string;
  category: CodexThreadCategory;
  mode: CodexThreadMode;
  status: CodexThreadStatus;
  goalStatus: CodexThreadGoalStatus;
  goalUpdatedAt?: number;
  parentCodexThreadId?: string;
  forkedAt?: number;
  createMethod?: CodexThreadCreateMethod;
  createRequestText?: string;
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
  forkBaseTokenUsageJson: string;
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
  docCommentId?: string;
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
  agentCardMessageId?: string;
  rawEventJson?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  tokenUsageJson: string;
}

export interface CronJobRecord {
  id: number;
  conversationKey: string;
  threadId: string;
  cronExpression: string;
  messageText: string;
  timezone: string;
  lastRunAt?: number;
  lastLarkMessageId?: string;
  createdByOpenId: string;
  createdAt: number;
  updatedAt: number;
}

export type LarkDocWatchMode = "owner" | "all";

export interface LarkDocWatcherRecord {
  id: number;
  fileType: string;
  fileToken: string;
  threadId: string;
  watchMode: LarkDocWatchMode;
  watchUrl: string;
  lastCommentReceivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexRenderedLarkMessage {
  attributes: Array<[string, string]>;
  content: string;
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
  replyToMessageForCodex?: CodexRenderedLarkMessage;
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
  inputValue?: string;
  formValue?: Record<string, unknown>;
  raw: unknown;
}

export interface IncomingLarkDocCommentAdd {
  eventId: string;
  fileType: string;
  fileToken: string;
  commentId: string;
  replyId?: string;
  senderOpenId: string;
  senderName?: string;
  isMentioned: boolean;
  createTime?: number;
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
  profile: ProfileName;
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
  skipped?: boolean;
  detail?: string;
}

export interface HealthSnapshot {
  ok: boolean;
  checks: HealthCheck[];
}
