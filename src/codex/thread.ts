import type { CodexProtocolClient } from "./protocol.js";

export type CodexApprovalPolicy = "never";

export interface ThreadStartParams {
  cwd: string;
  approvalPolicy: CodexApprovalPolicy;
  persistExtendedHistory: true;
}

export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string;
}

export interface ThreadForkParams extends ThreadStartParams {
  threadId: string;
  excludeTurns: true;
}

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

export function buildThreadStartParams(options: ThreadRuntimeOptions): ThreadStartParams {
  return {
    cwd: options.cwd,
    approvalPolicy: "never",
    persistExtendedHistory: true
  };
}

export function buildThreadResumeParams(threadId: string, options: ThreadRuntimeOptions): ThreadResumeParams {
  return {
    threadId,
    ...buildThreadStartParams(options)
  };
}

export function buildThreadForkParams(threadId: string, options: ThreadRuntimeOptions): ThreadForkParams {
  return {
    threadId,
    ...buildThreadStartParams(options),
    excludeTurns: true
  };
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
  options: ThreadRuntimeOptions
): Promise<ThreadForkResponse> {
  return protocol.request<ThreadForkResponse, ThreadForkParams>(
    "thread/fork",
    buildThreadForkParams(threadId, options)
  );
}
