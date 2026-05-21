import { TwinnyError, toErrorMessage } from "../errors.js";
import type {
  CodexAgentMessage,
  CodexRequestUserInputRequest,
  CodexThreadMode,
  CodexThreadTokenUsageUpdate,
  CodexTurnResult
} from "../types.js";
import type { CodexRequestUserInputResponder } from "./turn.js";
import { handleTurnServerRequest } from "./turn.js";
import type { CodexNotificationMessage, CodexProtocolClient, CodexRequestMessage } from "./protocol.js";
import { resumeCodexThread, type ThreadRuntimeOptions } from "./thread.js";

export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadGoalSetParams {
  threadId: string;
  objective?: string | null;
  status?: ThreadGoalStatus | null;
  tokenBudget?: number | null;
}

export interface ThreadGoalSetResponse {
  goal: ThreadGoal;
}

export interface ThreadGoalGetParams {
  threadId: string;
}

export interface ThreadGoalGetResponse {
  goal: ThreadGoal | null;
}

export interface ThreadGoalClearParams {
  threadId: string;
}

export interface GoalRunOptions {
  threadId: string;
  objective?: string;
  onTurnStarted?: (turnId: string) => Promise<void> | void;
  onAgentMessage?: (message: CodexAgentMessage) => Promise<void> | void;
  onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
  onGoalUpdated?: (goal: ThreadGoal, turnId: string | null) => Promise<void> | void;
  onGoalCleared?: () => Promise<void> | void;
  onRequestUserInput?: (
    request: CodexRequestUserInputRequest,
    responder: CodexRequestUserInputResponder
  ) => Promise<void> | void;
}

export interface GoalResumeOptions extends GoalRunOptions, ThreadRuntimeOptions {
  objective?: undefined;
}

export interface GoalRequestOptions {
  requestTimeoutMs?: number;
  completionTimeoutMs?: number;
}

export function buildThreadGoalSetParams(options: { threadId: string; objective: string }): ThreadGoalSetParams {
  return {
    threadId: options.threadId,
    objective: options.objective,
    status: "active"
  };
}

export async function setCodexThreadGoal(
  protocol: CodexProtocolClient,
  options: { threadId: string; objective: string },
  requestOptions: GoalRequestOptions = {}
): Promise<ThreadGoal> {
  const response = await protocol.request<ThreadGoalSetResponse, ThreadGoalSetParams>(
    "thread/goal/set",
    buildThreadGoalSetParams(options),
    { timeoutMs: requestOptions.requestTimeoutMs }
  );
  return response.goal;
}

export async function getCodexThreadGoal(
  protocol: CodexProtocolClient,
  threadId: string,
  requestOptions: GoalRequestOptions = {}
): Promise<ThreadGoal | null> {
  const response = await protocol.request<ThreadGoalGetResponse, ThreadGoalGetParams>(
    "thread/goal/get",
    { threadId },
    { timeoutMs: requestOptions.requestTimeoutMs }
  );
  return response.goal;
}

export async function clearCodexThreadGoal(
  protocol: CodexProtocolClient,
  threadId: string,
  requestOptions: GoalRequestOptions = {}
): Promise<void> {
  await protocol.request<Record<string, never>, ThreadGoalClearParams>(
    "thread/goal/clear",
    { threadId },
    { timeoutMs: requestOptions.requestTimeoutMs }
  );
}

export async function runCodexThreadGoal(
  protocol: CodexProtocolClient,
  options: GoalRunOptions,
  requestOptions: GoalRequestOptions = {}
): Promise<CodexTurnResult> {
  const accumulator = new GoalOutputAccumulator(options.threadId, options);
  const onNotification = (notification: CodexNotificationMessage): void => {
    accumulator.record(notification);
  };
  const onServerRequest = (request: CodexRequestMessage): void => {
    handleTurnServerRequest(protocol, goalOptionsAsTurnOptions(options), request);
  };

  protocol.on("notification", onNotification);
  protocol.on("serverRequest", onServerRequest);
  try {
    if (options.objective !== undefined) {
      const goal = await setCodexThreadGoal(protocol, {
        threadId: options.threadId,
        objective: options.objective
      }, requestOptions);
      accumulator.recordGoal(goal, null);
    } else {
      const goal = await getCodexThreadGoal(protocol, options.threadId, requestOptions);
      if (!goal) {
        throw new TwinnyError("Goal missed after relaunching", "CODEX_THREAD_GOAL_MISSING");
      }
      accumulator.recordGoal(goal, null);
    }
    return await accumulator.wait(requestOptions.completionTimeoutMs);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new TwinnyError(toErrorMessage(error), "CODEX_THREAD_GOAL_FAILED", error);
  } finally {
    protocol.off("notification", onNotification);
    protocol.off("serverRequest", onServerRequest);
    accumulator.dispose();
  }
}

export async function resumeCodexThreadGoal(
  protocol: CodexProtocolClient,
  options: GoalResumeOptions,
  requestOptions: GoalRequestOptions = {}
): Promise<CodexTurnResult> {
  const accumulator = new GoalOutputAccumulator(options.threadId, options);
  const onNotification = (notification: CodexNotificationMessage): void => {
    accumulator.record(notification);
  };
  const onServerRequest = (request: CodexRequestMessage): void => {
    handleTurnServerRequest(protocol, goalOptionsAsTurnOptions(options), request);
  };

  protocol.on("notification", onNotification);
  protocol.on("serverRequest", onServerRequest);
  try {
    await resumeCodexThread(protocol, options.threadId, { cwd: options.cwd });
    const goal = await getCodexThreadGoal(protocol, options.threadId, requestOptions);
    if (!goal) {
      throw new TwinnyError("Goal missed after relaunching", "CODEX_THREAD_GOAL_MISSING");
    }
    accumulator.recordGoal(goal, null);
    return await accumulator.wait(requestOptions.completionTimeoutMs);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new TwinnyError(toErrorMessage(error), "CODEX_THREAD_GOAL_FAILED", error);
  } finally {
    protocol.off("notification", onNotification);
    protocol.off("serverRequest", onServerRequest);
    accumulator.dispose();
  }
}

class GoalOutputAccumulator {
  private readonly assistantMessages = new Map<string, string>();
  private readonly emittedAgentMessageIds = new Set<string>();
  private readonly pendingAgentMessageCallbacks: Promise<void>[] = [];
  private readonly completedTurnIds = new Set<string>();
  private agentMessageCallbackChain = Promise.resolve();
  private readonly startedAt = Date.now();
  private turnId: string | undefined;
  private finalAnswerText: string | undefined;
  private terminalGoal: ThreadGoal | undefined;
  private terminalTurnId: string | null | undefined;
  private terminalFallbackTimer: NodeJS.Timeout | undefined;
  private completionError: Error | undefined;
  private resolved = false;
  private resolveWait: ((result: CodexTurnResult) => void) | undefined;
  private rejectWait: ((error: Error) => void) | undefined;

  constructor(
    private readonly threadId: string,
    private readonly callbacks: GoalRunOptions
  ) {}

  record(notification: CodexNotificationMessage): void {
    try {
      if (notification.method === "turn/started") {
        this.recordTurnStarted(notification.params);
        return;
      }
      if (notification.method === "item/completed") {
        this.recordItemCompleted(notification.params);
        return;
      }
      if (notification.method === "turn/completed") {
        this.recordTurnCompleted(notification.params);
        return;
      }
      if (notification.method === "thread/tokenUsage/updated") {
        this.recordTokenUsage(notification.params);
        return;
      }
      if (notification.method === "thread/goal/updated") {
        this.recordGoalUpdated(notification.params);
        return;
      }
      if (notification.method === "thread/goal/cleared") {
        this.recordGoalCleared(notification.params);
        return;
      }
      if (notification.method === "error") {
        this.recordError(notification.params);
      }
    } catch (error) {
      this.completionError =
        error instanceof Error ? error : new TwinnyError(toErrorMessage(error), "CODEX_THREAD_GOAL_AGGREGATION_ERROR");
      this.rejectWait?.(this.completionError);
    }
  }

  recordGoal(goal: ThreadGoal, turnId: string | null): void {
    if (goal.threadId !== this.threadId) {
      return;
    }
    void Promise.resolve(this.callbacks.onGoalUpdated?.(goal, turnId)).catch((error: unknown) => {
      const parsedError =
        error instanceof Error ? error : new TwinnyError(toErrorMessage(error), "CODEX_THREAD_GOAL_CALLBACK_FAILED");
      this.completionError = parsedError;
      this.rejectWait?.(parsedError);
    });
    if (isTerminalGoalStatus(goal.status)) {
      this.terminalGoal = goal;
      this.terminalTurnId = turnId;
      this.resolveTerminalIfReady();
    }
  }

  wait(timeoutMs = 0): Promise<CodexTurnResult> {
    if (this.completionError) {
      return Promise.reject(this.completionError);
    }
    if (this.terminalGoal && this.terminalReady()) {
      return this.resolveTerminal();
    }

    return new Promise<CodexTurnResult>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      this.resolveWait = (result) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(result);
      };
      this.rejectWait = (error) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(error);
      };

      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          reject(new TwinnyError("Timed out waiting for Codex goal completion", "CODEX_THREAD_GOAL_TIMEOUT"));
        }, timeoutMs);
      }
      this.resolveTerminalIfReady();
    });
  }

  dispose(): void {
    if (this.terminalFallbackTimer) {
      clearTimeout(this.terminalFallbackTimer);
      this.terminalFallbackTimer = undefined;
    }
  }

  private recordTurnStarted(params: unknown): void {
    if (!isRecord(params) || params.threadId !== this.threadId || !isRecord(params.turn)) {
      return;
    }
    const turnId = stringValue(params.turn.id);
    if (!turnId) {
      return;
    }
    this.turnId = turnId;
    void Promise.resolve(this.callbacks.onTurnStarted?.(turnId)).catch((error: unknown) => {
      const parsedError =
        error instanceof Error ? error : new TwinnyError(toErrorMessage(error), "CODEX_TURN_STARTED_CALLBACK_FAILED");
      this.completionError = parsedError;
      this.rejectWait?.(parsedError);
    });
  }

  private recordItemCompleted(params: unknown): void {
    if (!isItemCompletedParams(params) || params.threadId !== this.threadId) {
      return;
    }
    if (params.turnId) {
      this.turnId = params.turnId;
    }
    const item = extractAgentMessage(params.item);
    if (!item) {
      return;
    }
    this.assistantMessages.set(item.id, item.text);
    if (item.phase === "final_answer") {
      this.finalAnswerText = item.text;
    }
    this.emitAgentMessageOnce(item);
  }

  private recordTurnCompleted(params: unknown): void {
    if (!isTurnCompletedParams(params) || params.threadId !== this.threadId) {
      return;
    }
    const completedTurnId = stringValue(params.turn.id);
    if (completedTurnId) {
      this.turnId = completedTurnId;
      this.completedTurnIds.add(completedTurnId);
    }
    for (const item of params.turn.items ?? []) {
      const message = extractAgentMessage(item);
      if (message) {
        this.assistantMessages.set(message.id, message.text);
        if (message.phase === "final_answer") {
          this.finalAnswerText = message.text;
        }
        this.emitAgentMessageOnce(message);
      }
    }
    this.resolveTerminalIfReady();
  }

  private recordTokenUsage(params: unknown): void {
    if (!isRecord(params) || params.threadId !== this.threadId) {
      return;
    }
    const totalTokens = extractTotalTokens(params);
    if (totalTokens === undefined) {
      return;
    }
    const usage: CodexThreadTokenUsageUpdate = {
      threadId: this.threadId,
      turnId: stringValue(params.turnId),
      totalTokens,
      raw: params
    };
    void Promise.resolve(this.callbacks.onTokenUsage?.(usage)).catch((error: unknown) => {
      const parsedError =
        error instanceof Error ? error : new TwinnyError(toErrorMessage(error), "CODEX_TOKEN_USAGE_CALLBACK_FAILED");
      this.completionError = parsedError;
      this.rejectWait?.(parsedError);
    });
  }

  private recordGoalUpdated(params: unknown): void {
    if (!isRecord(params) || params.threadId !== this.threadId || !isThreadGoal(params.goal)) {
      return;
    }
    this.recordGoal(params.goal, stringValue(params.turnId) ?? null);
  }

  private recordGoalCleared(params: unknown): void {
    if (!isRecord(params) || params.threadId !== this.threadId) {
      return;
    }
    void Promise.resolve(this.callbacks.onGoalCleared?.()).catch((error: unknown) => {
      const parsedError =
        error instanceof Error ? error : new TwinnyError(toErrorMessage(error), "CODEX_THREAD_GOAL_CALLBACK_FAILED");
      this.completionError = parsedError;
      this.rejectWait?.(parsedError);
    });
    this.resolveInterrupted("Goal cleared");
  }

  private recordError(params: unknown): void {
    if (isRetryableTurnError(params)) {
      return;
    }
    const message =
      isRecord(params) && typeof params.message === "string"
        ? params.message
        : "Codex app-server reported an error";
    this.completionError = new TwinnyError(message, "CODEX_THREAD_GOAL_FAILED", params);
    this.rejectWait?.(this.completionError);
  }

  private emitAgentMessage(message: CodexAgentMessage): void {
    if (!this.callbacks.onAgentMessage) {
      return;
    }
    const pending = this.agentMessageCallbackChain
      .then(() => this.callbacks.onAgentMessage?.(message))
      .catch((error: unknown) => {
        const parsedError =
          error instanceof Error ? error : new TwinnyError(toErrorMessage(error), "CODEX_AGENT_MESSAGE_CALLBACK_FAILED");
        this.completionError = parsedError;
        this.rejectWait?.(parsedError);
      });
    this.agentMessageCallbackChain = pending.then(() => undefined);
    this.pendingAgentMessageCallbacks.push(pending);
  }

  private emitAgentMessageOnce(message: CodexAgentMessage): void {
    if (this.emittedAgentMessageIds.has(message.id)) {
      return;
    }
    this.emittedAgentMessageIds.add(message.id);
    this.emitAgentMessage(message);
  }

  private terminalReady(): boolean {
    return this.terminalTurnId === null ||
      this.terminalTurnId === undefined ||
      this.completedTurnIds.has(this.terminalTurnId);
  }

  private resolveTerminalIfReady(): void {
    if (!this.terminalGoal || this.resolved) {
      return;
    }
    if (this.terminalReady()) {
      if (!this.resolveWait) {
        return;
      }
      void this.resolveTerminal().then((result) => this.resolveWait?.(result), (error) => this.rejectWait?.(error));
      return;
    }
    if (!this.terminalFallbackTimer) {
      this.terminalFallbackTimer = setTimeout(() => {
        this.terminalFallbackTimer = undefined;
        void this.resolveTerminal().then((result) => this.resolveWait?.(result), (error) => this.rejectWait?.(error));
      }, 2_000);
      this.terminalFallbackTimer.unref?.();
    }
  }

  private async resolveTerminal(): Promise<CodexTurnResult> {
    if (this.resolved) {
      return this.toResult("interrupted", "Goal already resolved");
    }
    this.resolved = true;
    this.dispose();
    await Promise.all(this.pendingAgentMessageCallbacks);
    if (this.completionError) {
      throw this.completionError;
    }
    const goal = this.terminalGoal;
    if (!goal) {
      return this.toResult("interrupted", "Goal ended");
    }
    return goal.status === "complete"
      ? this.toResult("completed")
      : this.toResult("failed", `Goal ended with status ${goal.status}`);
  }

  private resolveInterrupted(error: string): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.dispose();
    void Promise.all(this.pendingAgentMessageCallbacks).then(() => {
      this.resolveWait?.(this.toResult("interrupted", error));
    }, (callbackError) => {
      const parsedError =
        callbackError instanceof Error ? callbackError : new TwinnyError(toErrorMessage(callbackError), "CODEX_AGENT_MESSAGE_CALLBACK_FAILED");
      this.rejectWait?.(parsedError);
    });
  }

  private toResult(status: CodexTurnResult["status"], error?: string): CodexTurnResult {
    return {
      threadId: this.threadId,
      turnId: this.turnId,
      text: this.finalAnswerText ?? this.text,
      status,
      error,
      durationMs: Date.now() - this.startedAt
    };
  }

  private get text(): string {
    return Array.from(this.assistantMessages.values())
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .join("\n\n");
  }
}

function goalOptionsAsTurnOptions(options: GoalRunOptions): {
  threadId: string;
  cwd: string;
  mode: CodexThreadMode;
  onRequestUserInput?: (
    request: CodexRequestUserInputRequest,
    responder: CodexRequestUserInputResponder
  ) => Promise<void> | void;
} {
  return {
    threadId: options.threadId,
    cwd: "",
    mode: "default",
    onRequestUserInput: options.onRequestUserInput
  };
}

function isTerminalGoalStatus(status: ThreadGoalStatus): boolean {
  return status === "complete" || status === "blocked" || status === "usageLimited" || status === "budgetLimited";
}

function isThreadGoal(value: unknown): value is ThreadGoal {
  return isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.objective === "string" &&
    isThreadGoalStatus(value.status);
}

function isThreadGoalStatus(value: unknown): value is ThreadGoalStatus {
  return value === "active" ||
    value === "paused" ||
    value === "blocked" ||
    value === "usageLimited" ||
    value === "budgetLimited" ||
    value === "complete";
}

interface ItemCompletedParams {
  threadId: string;
  turnId?: string;
  item?: unknown;
}

interface TurnCompletedParams {
  threadId: string;
  turn: {
    id?: string;
    items?: unknown[];
    status?: string;
    error?: unknown;
    durationMs?: number | null;
  };
}

function isItemCompletedParams(value: unknown): value is ItemCompletedParams {
  return isRecord(value) && typeof value.threadId === "string";
}

function isTurnCompletedParams(value: unknown): value is TurnCompletedParams {
  return isRecord(value) && typeof value.threadId === "string" && isRecord(value.turn);
}

function extractAgentMessage(item: unknown): CodexAgentMessage | undefined {
  if (!isRecord(item) || item.type !== "agentMessage") {
    return undefined;
  }
  const id = stringValue(item.id);
  const text = stringValue(item.text);
  if (!id || text === undefined) {
    return undefined;
  }
  const phase = agentMessagePhaseValue(item.phase);
  return phase === undefined ? { id, text } : { id, text, phase };
}

function agentMessagePhaseValue(value: unknown): CodexAgentMessage["phase"] | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

function extractTotalTokens(params: Record<string, unknown>): number | undefined {
  const usage = isRecord(params.usage) ? params.usage : undefined;
  const total = params.totalTokens ?? usage?.totalTokens ?? usage?.total_tokens;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

function isRetryableTurnError(params: unknown): boolean {
  if (!isRecord(params)) {
    return false;
  }
  const message = typeof params.message === "string" ? params.message.toLowerCase() : "";
  return message.includes("retry") || message.includes("rate limit");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
