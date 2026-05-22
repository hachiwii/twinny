import type { CodexProtocolClient } from "./protocol.js";

export type CodexApprovalPolicy = "never";

export interface ThreadRuntimeParams {
  cwd: string;
  approvalPolicy: CodexApprovalPolicy;
  persistExtendedHistory: boolean;
}

export interface ThreadStartParams extends ThreadRuntimeParams {
  dynamicTools: DynamicToolSpec[];
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

export interface CodexThread {
  id: string;
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

export interface ThreadRuntimeOptions {
  cwd: string;
}

export interface ThreadForkOptions extends ThreadRuntimeOptions {
  ephemeral?: boolean;
  developerInstructions?: string;
  model?: string;
  effort?: string;
}

export function buildThreadStartParams(options: ThreadRuntimeOptions): ThreadStartParams {
  return {
    cwd: options.cwd,
    approvalPolicy: "never",
    persistExtendedHistory: true,
    dynamicTools: [SET_THREAD_NAME_TOOL_SPEC]
  };
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

export async function setCodexThreadName(
  protocol: CodexProtocolClient,
  params: ThreadSetNameParams
): Promise<void> {
  await protocol.request<Record<string, never>, ThreadSetNameParams>("thread/name/set", params);
}
