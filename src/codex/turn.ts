import { TwinnyError, toErrorMessage } from "../errors.js";
import type { CodexTurnResult } from "../types.js";
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

export interface CompletedAgentMessage {
  id: string;
  text: string;
}

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
  requestOptions: { timeoutMs?: number } = {}
): Promise<CodexTurnResult> {
  const accumulator = new TurnOutputAccumulator(options.threadId, undefined, {
    onTurnStarted: options.onTurnStarted,
    onAgentMessage: options.onAgentMessage
  });
  const onNotification = (notification: CodexNotificationMessage): void => {
    accumulator.record(notification);
  };

  protocol.on("notification", onNotification);
  try {
    const response = await protocol.request<TurnStartResponse, TurnStartParams>(
      "turn/start",
      buildTurnStartParams(options),
      requestOptions
    );
    if (response.turn?.id) {
      accumulator.setTurnId(response.turn.id);
    }
    return await accumulator.wait(requestOptions.timeoutMs);
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

  private toResult(): CodexTurnResult {
    const turn = this.completed?.turn;
    const status = turn?.status === "failed" ? "failed" : turn?.status === "interrupted" ? "interrupted" : "completed";
    return {
      threadId: this.threadId,
      turnId: this.turnId,
      text: this.text,
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
  return { id, text };
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
