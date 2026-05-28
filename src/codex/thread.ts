import type { CodexProtocolClient } from "./protocol.js";

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

export const WAIT_FOR_THREAD_TOOL_SPEC: DynamicToolSpec = {
  namespace: "twinny",
  name: "wait_for_thread",
  description:
    "Wait for a Twinny-managed thread to become idle and for its queued work to clear. Returns the last turn final message and the latest 100 lines of process output when completed; interrupted or failed turns return the process tail instead of a final message.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["thread_id"],
    properties: {
      thread_id: { type: "string", minLength: 1 },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 3600000, default: 300000 }
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
  WAIT_FOR_THREAD_TOOL_SPEC,
  SEND_THREAD_REF_TOOL_SPEC,
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

export async function setCodexThreadName(
  protocol: CodexProtocolClient,
  params: ThreadSetNameParams
): Promise<void> {
  await protocol.request<Record<string, never>, ThreadSetNameParams>("thread/name/set", params);
}
