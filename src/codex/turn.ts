import { TwinnyError, toErrorMessage } from "../errors.js";
import type { AgentMessagePhase, CodexAgentMessage, CodexThreadTokenUsageUpdate, CodexTurnResult } from "../types.js";
import type { CodexNotificationMessage, CodexProtocolClient } from "./protocol.js";

export interface TextTurnInput {
  type: "text";
  text: string;
  text_elements: [];
}

export interface TurnStartParams {
  threadId: string;
  input: TextTurnInput[];
  cwd: string;
  approvalPolicy: "never";
}

export interface TurnStartOptions {
  threadId: string;
  text: string;
  cwd: string;
  onTurnStarted?: (turnId: string) => Promise<void> | void;
  onAgentMessage?: (message: CompletedAgentMessage) => Promise<void> | void;
  onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
}

export interface TurnRequestOptions {
  requestTimeoutMs?: number;
  completionTimeoutMs?: number;
}

export interface TurnStartResponse {
  turn?: {
    id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
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

interface ItemCompletedParams {
  threadId: string;
  turnId?: string;
  item?: unknown;
}

export type CompletedAgentMessage = CodexAgentMessage;

export interface TurnSteerOptions {
  threadId: string;
  turnId: string;
  text: string;
}

export interface TurnSteerParams {
  threadId: string;
  input: TextTurnInput[];
  expectedTurnId: string;
}

export interface TurnInterruptOptions {
  threadId: string;
  turnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export function buildTextTurnInput(text: string): TextTurnInput {
  return {
    type: "text",
    text,
    text_elements: []
  };
}

export function buildTurnStartParams(options: TurnStartOptions): TurnStartParams {
  return {
    threadId: options.threadId,
    input: [buildTextTurnInput(options.text)],
    cwd: options.cwd,
    approvalPolicy: "never"
  };
}

export function buildTurnSteerParams(options: TurnSteerOptions): TurnSteerParams {
  return {
    threadId: options.threadId,
    input: [buildTextTurnInput(options.text)],
    expectedTurnId: options.turnId
  };
}

export function buildTurnInterruptParams(options: TurnInterruptOptions): TurnInterruptParams {
  return {
    threadId: options.threadId,
    turnId: options.turnId
  };
}

export async function startCodexTurn(
  protocol: CodexProtocolClient,
  options: TurnStartOptions,
  requestOptions: TurnRequestOptions = {}
): Promise<CodexTurnResult> {
  const accumulator = new TurnOutputAccumulator(options.threadId, undefined, {
    onTurnStarted: options.onTurnStarted,
    onAgentMessage: options.onAgentMessage,
    onTokenUsage: options.onTokenUsage
  });
  const onNotification = (notification: CodexNotificationMessage): void => {
    accumulator.record(notification);
  };

  protocol.on("notification", onNotification);
  try {
    const response = await protocol.request<TurnStartResponse, TurnStartParams>(
      "turn/start",
      buildTurnStartParams(options),
      { timeoutMs: requestOptions.requestTimeoutMs }
    );
    if (response.turn?.id) {
      accumulator.setTurnId(response.turn.id);
    }
    return await accumulator.wait(requestOptions.completionTimeoutMs);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new TwinnyError(toErrorMessage(error), "CODEX_TURN_FAILED", error);
  } finally {
    protocol.off("notification", onNotification);
  }
}

export async function steerCodexTurn(protocol: CodexProtocolClient, options: TurnSteerOptions): Promise<void> {
  await protocol.request<Record<string, never>, TurnSteerParams>("turn/steer", buildTurnSteerParams(options));
}

export async function interruptCodexTurn(protocol: CodexProtocolClient, options: TurnInterruptOptions): Promise<void> {
  await protocol.request<Record<string, never>, TurnInterruptParams>(
    "turn/interrupt",
    buildTurnInterruptParams(options)
  );
}

export class TurnOutputAccumulator {
  private readonly assistantMessages = new Map<string, string>();
  private readonly pendingAgentMessageCallbacks: Promise<void>[] = [];
  private agentMessageCallbackChain = Promise.resolve();
  private readonly startedAt = Date.now();
  private finalAnswerText: string | undefined;
  private turnId: string | undefined;
  private emittedTurnStarted = false;
  private completed: TurnCompletedParams | undefined;
  private completionError: Error | undefined;
  private resolveWait: ((result: CodexTurnResult) => void) | undefined;
  private rejectWait: ((error: Error) => void) | undefined;

  constructor(
    private readonly threadId: string,
    turnId?: string,
    private readonly callbacks: {
      onTurnStarted?: (turnId: string) => Promise<void> | void;
      onAgentMessage?: (message: CompletedAgentMessage) => Promise<void> | void;
      onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
    } = {}
  ) {
    this.turnId = turnId;
  }

  setTurnId(turnId: string): void {
    if (!this.turnId) {
      this.turnId = turnId;
    }
    if (!this.emittedTurnStarted) {
      this.emittedTurnStarted = true;
      void Promise.resolve(this.callbacks.onTurnStarted?.(this.turnId)).catch((error: unknown) => {
        const parsedError =
          error instanceof Error ? error : new TwinnyError(toErrorMessage(error), "CODEX_TURN_STARTED_CALLBACK_FAILED");
        this.completionError = parsedError;
        this.rejectWait?.(parsedError);
      });
    }
  }

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
      if (notification.method === "error") {
        this.recordError(notification.params);
      }
    } catch (error) {
      this.completionError =
        error instanceof Error ? error : new TwinnyError(toErrorMessage(error), "CODEX_TURN_AGGREGATION_ERROR");
      this.rejectWait?.(this.completionError);
    }
  }

  wait(timeoutMs = 0): Promise<CodexTurnResult> {
    if (this.completionError) {
      return Promise.reject(this.completionError);
    }
    if (this.completed) {
      return this.waitForPendingAgentMessageCallbacks().then(() => this.toResult());
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
          reject(new TwinnyError("Timed out waiting for Codex turn completion", "CODEX_TURN_TIMEOUT"));
        }, timeoutMs);
      }
    });
  }

  get text(): string {
    return Array.from(this.assistantMessages.values())
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .join("\n\n");
  }

  private recordTurnStarted(params: unknown): void {
    if (!isRecord(params) || params.threadId !== this.threadId || !isRecord(params.turn)) {
      return;
    }
    const turnId = stringValue(params.turn.id);
    if (turnId) {
      this.setTurnId(turnId);
    }
  }

  private recordItemCompleted(params: unknown): void {
    if (!isItemCompletedParams(params)) {
      return;
    }
    if (params.threadId !== this.threadId) {
      return;
    }
    if (this.turnId && params.turnId && params.turnId !== this.turnId) {
      return;
    }

    const item = extractAgentMessage(params.item);
    if (item) {
      this.assistantMessages.set(item.id, item.text);
      if (item.phase === "final_answer") {
        this.finalAnswerText = item.text;
      }
      this.emitAgentMessage(item);
    }
  }

  private recordTurnCompleted(params: unknown): void {
    if (!isTurnCompletedParams(params)) {
      return;
    }
    if (params.threadId !== this.threadId) {
      return;
    }
    const completedTurnId = stringValue(params.turn.id);
    if (this.turnId && completedTurnId && completedTurnId !== this.turnId) {
      return;
    }
    if (completedTurnId) {
      this.setTurnId(completedTurnId);
    }

    for (const item of params.turn.items ?? []) {
      const message = extractAgentMessage(item);
      if (message) {
        this.assistantMessages.set(message.id, message.text);
        if (message.phase === "final_answer") {
          this.finalAnswerText = message.text;
        }
      }
    }

    this.completed = params;
    void this.resolveCompleted();
  }

  private recordError(params: unknown): void {
    const message =
      isRecord(params) && typeof params.message === "string"
        ? params.message
        : "Codex app-server reported an error";
    this.completionError = new TwinnyError(message, "CODEX_TURN_FAILED", params);
    this.rejectWait?.(this.completionError);
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

  private toResult(): CodexTurnResult {
    const turn = this.completed?.turn;
    const status = turn?.status === "failed" ? "failed" : turn?.status === "interrupted" ? "interrupted" : "completed";
    return {
      threadId: this.threadId,
      turnId: this.turnId,
      text: this.finalAnswerText ?? this.text,
      status,
      error: status === "failed" ? extractErrorMessage(turn?.error) : undefined,
      durationMs: typeof turn?.durationMs === "number" ? turn.durationMs : Date.now() - this.startedAt
    };
  }

  private emitAgentMessage(message: CompletedAgentMessage): void {
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

  private async resolveCompleted(): Promise<void> {
    await this.waitForPendingAgentMessageCallbacks();
    if (this.completionError) {
      this.rejectWait?.(this.completionError);
      return;
    }
    this.resolveWait?.(this.toResult());
  }

  private async waitForPendingAgentMessageCallbacks(): Promise<void> {
    await Promise.all(this.pendingAgentMessageCallbacks);
  }
}

function extractAgentMessage(item: unknown): CompletedAgentMessage | undefined {
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

function agentMessagePhaseValue(value: unknown): AgentMessagePhase | null | undefined {
  if (value === null) {
    return null;
  }
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

function extractErrorMessage(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
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
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function isTurnCompletedParams(value: unknown): value is TurnCompletedParams {
  return isRecord(value) && typeof value.threadId === "string" && isRecord(value.turn);
}

function isItemCompletedParams(value: unknown): value is ItemCompletedParams {
  return isRecord(value) && typeof value.threadId === "string";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
