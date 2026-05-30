import type { CodexThreadTokenUsageUpdate } from "../types.js";
import type { CodexNotificationMessage, CodexProtocolClient } from "./protocol.js";

export type CodexApprovalPolicy = "never";

export interface ThreadRuntimeParams {
  cwd: string;
  approvalPolicy: CodexApprovalPolicy;
  persistExtendedHistory: boolean;
}

export interface ThreadStartParams extends ThreadRuntimeParams {
  dynamicTools: DynamicToolSpec[];
  developerInstructions?: string;
}

export interface ThreadResumeParams extends ThreadRuntimeParams {
  threadId: string;
}

export interface ThreadForkParams extends ThreadRuntimeParams {
  threadId: string;
  excludeTurns: true;
  persistExtendedHistory: boolean;
  developerInstructions?: string;
  ephemeral?: boolean;
  model?: string;
  config?: Record<string, unknown>;
}

export type ThreadSourceKind =
  | "cli"
  | "vscode"
  | "exec"
  | "appServer"
  | "subAgent"
  | "subAgentReview"
  | "subAgentCompact"
  | "subAgentThreadSpawn"
  | "subAgentOther"
  | "unknown";

export interface DynamicToolSpec {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

export const SET_THREAD_NAME_TOOL_SPEC: DynamicToolSpec = {
  namespace: "twinny",
  name: "set_thread_name",
  description:
    "Update the current thread name. Call this at the beginning of a conversation after understanding the work, and call it again whenever the current thread name does not match the actual work. Keep the name concise, within 15 Chinese characters or 10 words.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: {
        type: "string",
        minLength: 1,
        description:
          "New thread name. Keep it concise, within 15 Chinese characters or 10 words. Do not include explanations."
      }
    }
  },
  deferLoading: false
};

export const LIST_THREADS_TOOL_SPEC: DynamicToolSpec = {
  namespace: "twinny",
  name: "list_threads",
  description:
    "List Twinny-managed threads in the current conversation. Results are ordered by update time with the current conversation main thread pinned first. Supports pagination with page_size up to 100.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      page: { type: "integer", minimum: 1, default: 1 },
      page_size: { type: "integer", minimum: 1, maximum: 100, default: 20 }
    }
  },
  deferLoading: false
};

export const SEARCH_THREADS_TOOL_SPEC: DynamicToolSpec = {
  namespace: "twinny",
  name: "search_threads",
  description:
    "Search Twinny-managed threads in the current conversation. Returns list_threads thread objects plus Codex search snippets. Supports timestamp cursor pagination with limit up to 100.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["searchTerm"],
    properties: {
      searchTerm: {
        type: "string",
        minLength: 1,
        description: "Search text. Twinny trims whitespace and rejects an empty search term."
      },
      cursor: {
        type: ["string", "null"],
        description: "Pagination cursor returned by a previous search_threads call."
      },
      limit: { type: ["integer", "null"], minimum: 1, maximum: 100, default: 25 },
      sortKey: {
        type: ["string", "null"],
        enum: ["created_at", "updated_at", null],
        default: "created_at"
      },
      sortDirection: {
        type: ["string", "null"],
        enum: ["asc", "desc", null],
        default: "desc"
      }
    }
  },
  deferLoading: false
};

export const NEW_THREAD_TOOL_SPEC: DynamicToolSpec = {
  namespace: "twinny",
  name: "new_thread",
  description:
    "Create a new Twinny topic thread or fork in the current conversation. workspace, model, and effort default to the current thread when omitted. fork=false creates a fresh thread; fork=true forks the current thread. mode defaults to default, name defaults to Twinny's normal new thread/fork thread title, and initial_message defaults to empty. This operation automatically sends the topic to the user, so do not call send_thread_ref afterward.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      workspace: { type: "string", minLength: 1 },
      model: { type: "string", minLength: 1 },
      effort: { type: "string", minLength: 1 },
      fork: { type: "boolean", default: false },
      mode: { type: "string", enum: ["default", "plan"], default: "default" },
      name: { type: "string", minLength: 1, maxLength: 80 },
      initial_message: { type: "string", default: "" }
    }
  },
  deferLoading: false
};

export const WAIT_FOR_THREADS_TOOL_SPEC: DynamicToolSpec = {
  namespace: "twinny",
  name: "wait_for_threads",
  description:
    "Wait for Twinny-managed threads to become idle and for their queued work to clear. Accepts a list of thread IDs and returns only after every thread is idle. A thread counts as waited once it has sent an idle signal. Use timeout_ms: 0 when you only want to inspect the current status and latest output without waiting. Returns each thread's last turn final message and latest 100 lines of process output; interrupted or failed turns return the process tail instead of a final message.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["thread_ids"],
    properties: {
      thread_ids: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 }
      },
      timeout_ms: { type: "integer", minimum: 0, maximum: 3600000, default: 300000 }
    }
  },
  deferLoading: false
};

export const SEND_THREAD_REF_TOOL_SPEC: DynamicToolSpec = {
  namespace: "twinny",
  name: "send_thread_ref",
  description:
    "Forward a Twinny conversation thread reference into the current conversation. The target must be a normal thread with a Lark thread id; main, previous main, or unbound threads are rejected.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["thread_id"],
    properties: {
      thread_id: { type: "string", minLength: 1 }
    }
  },
  deferLoading: false
};

export const TELL_THREAD_TOOL_SPEC: DynamicToolSpec = {
  namespace: "twinny",
  name: "tell_thread",
  description:
    "Send a text message to another Twinny-managed thread in the current conversation. The target thread receives the message through its Lark thread, or the conversation chat for the main thread. mode defaults to queue. queue creates a new queued item, preserving the existing behavior. steer injects into the target's current active turn; if the target has no active turn, it starts a new turn. interrupt interrupts the target's active turn if present, then starts a new turn.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["thread_id", "msg"],
    properties: {
      thread_id: { type: "string", minLength: 1 },
      msg: { type: "string", minLength: 1 },
      mode: { type: "string", enum: ["queue", "steer", "interrupt"], default: "queue" }
    }
  },
  deferLoading: false
};

export const ADD_CRON_TOOL_SPEC: DynamicToolSpec = {
  namespace: "twinny",
  name: "add_cron",
  description:
    "Create a cron job in the current conversation. The job sends msg to the current thread by default, or to thread_id when provided. Cron expressions use the local timezone.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["cron_exp", "msg"],
    properties: {
      cron_exp: { type: "string", minLength: 1 },
      msg: { type: "string", minLength: 1 },
      thread_id: { type: "string", minLength: 1 }
    }
  },
  deferLoading: false
};

export const LIST_CRON_TOOL_SPEC: DynamicToolSpec = {
  namespace: "twinny",
  name: "list_cron",
  description:
    "List cron jobs in the current conversation. Results include cron_id, cron expression, message, target thread, next run time, last run time, and last Lark message id.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {}
  },
  deferLoading: false
};

export const DEL_CRON_TOOL_SPEC: DynamicToolSpec = {
  namespace: "twinny",
  name: "del_cron",
  description: "Delete a cron job from the current conversation by cron_id.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["cron_id"],
    properties: {
      cron_id: { type: "integer", minimum: 1 }
    }
  },
  deferLoading: false
};

export const CREATE_CONVERSATION_TOOL_SPEC: DynamicToolSpec = {
  namespace: "twinny",
  name: "create_conversation",
  description:
    "Create a new Twinny conversation/project group only when the user or instructions explicitly ask for a new Twinny conversation or project group. Do not use this for ordinary Feishu/Lark group creation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80 },
      member_open_ids: {
        type: "array",
        items: { type: "string", minLength: 1 },
        maxItems: 50,
        default: []
      },
      response_mode: {
        type: "string",
        enum: ["all", "all_at", "owner", "owner_at", "none"]
      },
      profile: { type: "string", minLength: 1, maxLength: 64 }
    }
  },
  deferLoading: false
};

export const TWINNY_DYNAMIC_TOOL_SPECS: DynamicToolSpec[] = [
  SET_THREAD_NAME_TOOL_SPEC,
  LIST_THREADS_TOOL_SPEC,
  SEARCH_THREADS_TOOL_SPEC,
  NEW_THREAD_TOOL_SPEC,
  WAIT_FOR_THREADS_TOOL_SPEC,
  SEND_THREAD_REF_TOOL_SPEC,
  TELL_THREAD_TOOL_SPEC,
  ADD_CRON_TOOL_SPEC,
  LIST_CRON_TOOL_SPEC,
  DEL_CRON_TOOL_SPEC,
  CREATE_CONVERSATION_TOOL_SPEC
];

export interface CodexThread {
  id: string;
  name?: string | null;
  preview?: string | null;
  cwd?: string;
  path?: string | null;
  createdAt?: number;
  updatedAt?: number;
  turns?: ThreadTurn[];
  [key: string]: unknown;
}

export interface ThreadStartResponse {
  thread: CodexThread;
  [key: string]: unknown;
}

export interface ThreadResumeResponse {
  thread: CodexThread;
  [key: string]: unknown;
}

export interface ThreadForkResponse {
  thread: CodexThread;
  [key: string]: unknown;
}

export interface ThreadReadParams {
  threadId: string;
  includeTurns: boolean;
}

export interface ThreadReadResponse {
  thread: CodexThread;
}

export interface ThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: "created_at" | "updated_at" | null;
  sortDirection?: "asc" | "desc" | null;
  sourceKinds?: ThreadSourceKind[] | null;
  archived?: boolean | null;
  useStateDbOnly?: boolean;
}

export interface ThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ThreadSearchParams {
  searchTerm: string;
  cursor?: string | null;
  limit?: number | null;
  sortKey?: "created_at" | "updated_at" | null;
  sortDirection?: "asc" | "desc" | null;
  sourceKinds?: ThreadSourceKind[] | null;
  archived?: boolean | null;
}

export interface ThreadSearchResult {
  thread: CodexThread;
  snippet: string;
}

export interface ThreadSearchResponse {
  data: ThreadSearchResult[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ThreadRollbackParams {
  threadId: string;
  numTurns: number;
}

export interface ThreadRollbackResponse {
  thread: CodexThread;
  tokenUsage?: CodexThreadTokenUsageUpdate;
}

export type ThreadItem =
  | { type: "userMessage"; id: string; content: unknown[] }
  | { type: "agentMessage"; id: string; text: string; phase?: string | null }
  | { type: string; id?: string; [key: string]: unknown };

export interface ThreadTurn {
  id: string;
  items: ThreadItem[];
  itemsView: "notLoaded" | "summary" | "full";
  status: string;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface ThreadRuntimeOptions {
  cwd: string;
  developerInstructions?: string;
}

export interface ThreadForkOptions extends ThreadRuntimeOptions {
  ephemeral?: boolean;
  model?: string;
  effort?: string;
}

export function buildThreadStartParams(options: ThreadRuntimeOptions): ThreadStartParams {
  const params: ThreadStartParams = {
    cwd: options.cwd,
    approvalPolicy: "never",
    persistExtendedHistory: true,
    dynamicTools: TWINNY_DYNAMIC_TOOL_SPECS
  };
  if (options.developerInstructions) {
    params.developerInstructions = options.developerInstructions;
  }
  return params;
}

export function buildThreadResumeParams(threadId: string, options: ThreadRuntimeOptions): ThreadResumeParams {
  return {
    threadId,
    cwd: options.cwd,
    approvalPolicy: "never",
    persistExtendedHistory: true
  };
}

export function buildThreadForkParams(threadId: string, options: ThreadForkOptions): ThreadForkParams {
  const params: ThreadForkParams = {
    threadId,
    cwd: options.cwd,
    approvalPolicy: "never",
    persistExtendedHistory: true,
    excludeTurns: true
  };
  if (options.ephemeral) {
    params.ephemeral = true;
    params.persistExtendedHistory = false;
  }
  if (options.developerInstructions) {
    params.developerInstructions = options.developerInstructions;
  }
  if (options.model) {
    params.model = options.model;
  }
  if (options.effort) {
    params.config = { model_reasoning_effort: options.effort };
  }
  return params;
}

export interface ThreadSetNameParams {
  threadId: string;
  name: string;
}

export async function startCodexThread(
  protocol: CodexProtocolClient,
  options: ThreadRuntimeOptions
): Promise<ThreadStartResponse> {
  return protocol.request<ThreadStartResponse, ThreadStartParams>("thread/start", buildThreadStartParams(options));
}

export async function resumeCodexThread(
  protocol: CodexProtocolClient,
  threadId: string,
  options: ThreadRuntimeOptions
): Promise<ThreadResumeResponse> {
  return protocol.request<ThreadResumeResponse, ThreadResumeParams>(
    "thread/resume",
    buildThreadResumeParams(threadId, options)
  );
}

export async function forkCodexThread(
  protocol: CodexProtocolClient,
  threadId: string,
  options: ThreadForkOptions
): Promise<ThreadForkResponse> {
  return protocol.request<ThreadForkResponse, ThreadForkParams>(
    "thread/fork",
    buildThreadForkParams(threadId, options)
  );
}

export interface ThreadInjectItemsParams {
  threadId: string;
  items: unknown[];
}

export async function injectCodexThreadItems(
  protocol: CodexProtocolClient,
  params: ThreadInjectItemsParams
): Promise<void> {
  await protocol.request<Record<string, never>, ThreadInjectItemsParams>("thread/inject_items", params);
}

export interface ThreadUnsubscribeParams {
  threadId: string;
}

export async function unsubscribeCodexThread(
  protocol: CodexProtocolClient,
  threadId: string
): Promise<void> {
  await protocol.request<Record<string, unknown>, ThreadUnsubscribeParams>("thread/unsubscribe", { threadId });
}

export async function readCodexThread(
  protocol: CodexProtocolClient,
  threadId: string,
  options: { includeTurns?: boolean } = {}
): Promise<ThreadReadResponse> {
  return protocol.request<ThreadReadResponse, ThreadReadParams>("thread/read", {
    threadId,
    includeTurns: options.includeTurns ?? false
  });
}

export async function listCodexThreads(
  protocol: CodexProtocolClient,
  params: ThreadListParams = {}
): Promise<ThreadListResponse> {
  return protocol.request<ThreadListResponse, ThreadListParams>("thread/list", params);
}

export async function searchCodexThreads(
  protocol: CodexProtocolClient,
  params: ThreadSearchParams
): Promise<ThreadSearchResponse> {
  return protocol.request<ThreadSearchResponse, ThreadSearchParams>("thread/search", params);
}

export async function rollbackCodexThread(
  protocol: CodexProtocolClient,
  params: ThreadRollbackParams,
  options: { tokenUsageWaitMs?: number } = {}
): Promise<ThreadRollbackResponse> {
  let tokenUsage: CodexThreadTokenUsageUpdate | undefined;
  let resolveTokenUsage: ((usage: CodexThreadTokenUsageUpdate | undefined) => void) | undefined;
  const tokenUsagePromise = new Promise<CodexThreadTokenUsageUpdate | undefined>((resolve) => {
    resolveTokenUsage = resolve;
  });
  const onNotification = (message: CodexNotificationMessage) => {
    const parsed = parseThreadTokenUsageNotification(message, params.threadId);
    if (!parsed) {
      return;
    }
    tokenUsage = parsed;
    resolveTokenUsage?.(parsed);
  };

  protocol.on("notification", onNotification);
  try {
    const response = await protocol.request<ThreadRollbackResponse, ThreadRollbackParams>("thread/rollback", params);
    if (!tokenUsage) {
      tokenUsage = await waitForTokenUsage(tokenUsagePromise, options.tokenUsageWaitMs ?? 500);
    }
    return tokenUsage ? { ...response, tokenUsage } : response;
  } finally {
    protocol.off("notification", onNotification);
  }
}

export async function setCodexThreadName(
  protocol: CodexProtocolClient,
  params: ThreadSetNameParams
): Promise<void> {
  await protocol.request<Record<string, never>, ThreadSetNameParams>("thread/name/set", params);
}

function parseThreadTokenUsageNotification(
  message: CodexNotificationMessage,
  threadId: string
): CodexThreadTokenUsageUpdate | undefined {
  if (message.method !== "thread/tokenUsage/updated" || !isRecord(message.params) || message.params.threadId !== threadId) {
    return undefined;
  }
  const totalTokens = extractTotalTokens(message.params);
  if (totalTokens === undefined) {
    return undefined;
  }
  return {
    threadId,
    turnId: stringValue(message.params.turnId),
    totalTokens,
    raw: message.params
  };
}

async function waitForTokenUsage(
  promise: Promise<CodexThreadTokenUsageUpdate | undefined>,
  waitMs: number
): Promise<CodexThreadTokenUsageUpdate | undefined> {
  if (waitMs <= 0) {
    return undefined;
  }
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), waitMs);
    })
  ]);
}

function extractTotalTokens(params: Record<string, unknown>): number | undefined {
  return firstFiniteNumber(
    params.totalTokens,
    params.total_tokens,
    nestedValue(params, ["usage", "totalTokens"]),
    nestedValue(params, ["usage", "total_tokens"]),
    nestedValue(params, ["usage", "total", "totalTokens"]),
    nestedValue(params, ["usage", "total", "total_tokens"]),
    nestedValue(params, ["total", "totalTokens"]),
    nestedValue(params, ["total", "total_tokens"]),
    nestedValue(params, ["tokenUsage", "totalTokens"]),
    nestedValue(params, ["tokenUsage", "total_tokens"]),
    nestedValue(params, ["tokenUsage", "total", "totalTokens"]),
    nestedValue(params, ["tokenUsage", "total", "total_tokens"])
  );
}

function nestedValue(record: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
