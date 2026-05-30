import { TwinnyError, toErrorMessage } from "../errors.js";
import type {
  AgentMessagePhase,
  CodexAgentMessage,
  CodexErrorNotification,
  CodexImageGeneration,
  CodexPlanUpdate,
  CodexRequestUserInputParams,
  CodexRequestUserInputRequest,
  CodexRequestUserInputResponse,
  CodexThreadMode,
  CodexThreadTokenUsageUpdate,
  CodexTurnResult
} from "../types.js";
import type { CodexNotificationMessage, CodexProtocolClient, CodexRequestMessage } from "./protocol.js";
import { isThreadGoal, type ThreadGoal } from "./goal.js";

export interface TextTurnInput {
  type: "text";
  text: string;
  text_elements: [];
}

export interface LocalImageTurnInput {
  type: "localImage";
  path: string;
  detail: null;
}

export type CodexUserInput = TextTurnInput | LocalImageTurnInput;

export type CodexTurnInput = string | CodexUserInput[];

export interface TurnStartParams {
  threadId: string;
  input: CodexUserInput[];
  cwd: string;
  approvalPolicy: "never";
  sandboxPolicy?: CodexSandboxPolicy;
  collaborationMode?: {
    mode: CodexThreadMode;
    settings: {
      model: string;
      reasoning_effort: string | null;
      developer_instructions: string | null;
    };
  };
}

export type CodexSandboxPolicy = { type: "dangerFullAccess" };

export const DANGER_FULL_ACCESS_SANDBOX_POLICY: CodexSandboxPolicy = { type: "dangerFullAccess" };

export interface TurnStartOptions {
  threadId: string;
  text?: string;
  input?: CodexTurnInput;
  currentThreadName?: string;
  cwd: string;
  sandboxPolicy?: CodexSandboxPolicy;
  mode?: CodexThreadMode;
  model?: string;
  effort?: string;
  onTurnStarted?: (turnId: string) => Promise<void> | void;
  onAgentMessage?: (message: CompletedAgentMessage) => Promise<void> | void;
  onImageGeneration?: (image: CodexImageGeneration) => Promise<void> | void;
  onCodexError?: (error: CodexErrorNotification) => Promise<void> | void;
  onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
  onGoalUpdated?: (goal: ThreadGoal, turnId: string | null) => Promise<void> | void;
  onGoalCleared?: () => Promise<void> | void;
  onPlanUpdated?: (plan: CodexPlanUpdate) => Promise<void> | void;
  onRequestUserInput?: (
    request: CodexRequestUserInputRequest,
    responder: CodexRequestUserInputResponder
  ) => Promise<void> | void;
  onSetThreadName?: (request: CodexSetThreadNameToolRequest) => Promise<CodexDynamicToolCallResponse> | CodexDynamicToolCallResponse;
  onDynamicToolCall?: (request: CodexTwinnyDynamicToolRequest) => Promise<CodexDynamicToolCallResponse> | CodexDynamicToolCallResponse;
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

type TurnIdSource = "response" | "notification";

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

export interface CodexRequestUserInputResponder {
  respond(response: CodexRequestUserInputResponse): void;
  reject(error: Error | string): void;
}

export interface CodexSetThreadNameToolRequest {
  requestId: string | number;
  threadId: string;
  turnId: string;
  callId: string;
  name: string;
  rawArguments: unknown;
}

interface CodexDynamicToolRequestBase {
  requestId: string | number;
  threadId: string;
  turnId: string;
  callId: string;
  rawArguments: unknown;
}

export interface CodexListThreadsToolRequest extends CodexDynamicToolRequestBase {
  tool: "list_threads";
  page: number;
  pageSize: number;
}

export interface CodexNewThreadToolRequest extends CodexDynamicToolRequestBase {
  tool: "new_thread";
  workspace?: string;
  model?: string;
  effort?: string;
  fork: boolean;
  mode: CodexThreadMode;
  name?: string;
  initialMessage: string;
}

export interface CodexWaitForThreadsToolRequest extends CodexDynamicToolRequestBase {
  tool: "wait_for_threads";
  targetThreadIds: string[];
  timeoutMs: number;
}

export interface CodexSendThreadRefToolRequest extends CodexDynamicToolRequestBase {
  tool: "send_thread_ref";
  targetThreadId: string;
}

export interface CodexTellThreadToolRequest extends CodexDynamicToolRequestBase {
  tool: "tell_thread";
  targetThreadId: string;
  message: string;
}

export interface CodexAddCronToolRequest extends CodexDynamicToolRequestBase {
  tool: "add_cron";
  cronExpression: string;
  message: string;
  targetThreadId?: string;
}

export interface CodexListCronToolRequest extends CodexDynamicToolRequestBase {
  tool: "list_cron";
}

export interface CodexDelCronToolRequest extends CodexDynamicToolRequestBase {
  tool: "del_cron";
  cronId: number;
}

export interface CodexCreateConversationToolRequest extends CodexDynamicToolRequestBase {
  tool: "create_conversation";
  name: string;
  memberOpenIds: string[];
  responseMode?: "all" | "all_at" | "owner" | "owner_at" | "none";
  profile?: string;
}

export type CodexTwinnyDynamicToolRequest =
  | CodexListThreadsToolRequest
  | CodexNewThreadToolRequest
  | CodexWaitForThreadsToolRequest
  | CodexSendThreadRefToolRequest
  | CodexTellThreadToolRequest
  | CodexAddCronToolRequest
  | CodexListCronToolRequest
  | CodexDelCronToolRequest
  | CodexCreateConversationToolRequest;

export interface CodexDynamicToolCallResponse {
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string }>;
}

export interface TurnSteerOptions {
  threadId: string;
  turnId: string;
  text?: string;
  input?: CodexTurnInput;
}

export interface TurnSteerParams {
  threadId: string;
  input: CodexUserInput[];
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

export interface ThreadCompactStartOptions {
  threadId: string;
  onTurnStarted?: (turnId: string) => Promise<void> | void;
  onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
}

export interface ThreadCompactStartParams {
  threadId: string;
}

export function buildTextTurnInput(text: string): TextTurnInput {
  return {
    type: "text",
    text,
    text_elements: []
  };
}

export function buildLocalImageTurnInput(path: string): LocalImageTurnInput {
  return {
    type: "localImage",
    path,
    detail: null
  };
}

export function normalizeCodexTurnInput(input?: CodexTurnInput, fallbackText = ""): CodexUserInput[] {
  if (Array.isArray(input)) {
    return input;
  }
  return [buildTextTurnInput(input ?? fallbackText)];
}

export function prefixCurrentThreadNameInput(input: CodexUserInput[], threadName: string): CodexUserInput[] {
  const prefix = `<current_thread_name>${escapeXmlText(threadName)}</current_thread_name>\n`;
  const firstTextIndex = input.findIndex((item) => item.type === "text");
  if (firstTextIndex < 0) {
    return [buildTextTurnInput(prefix), ...input];
  }
  return input.map((item, index): CodexUserInput => {
    if (index !== firstTextIndex || item.type !== "text") {
      return item;
    }
    return {
      ...item,
      text: `${prefix}${item.text}`
    };
  });
}

export function buildTurnStartParams(options: TurnStartOptions): TurnStartParams {
  const input = normalizeCodexTurnInput(options.input, options.text ?? "");
  const params: TurnStartParams = {
    threadId: options.threadId,
    input: options.currentThreadName === undefined ? input : prefixCurrentThreadNameInput(input, options.currentThreadName),
    cwd: options.cwd,
    approvalPolicy: "never"
  };
  if (options.sandboxPolicy) {
    params.sandboxPolicy = options.sandboxPolicy;
  }
  if (options.mode) {
    params.collaborationMode = {
      mode: options.mode,
      settings: {
        model: options.model ?? "gpt-5.5",
        reasoning_effort: options.effort ?? "medium",
        developer_instructions: null
      }
    };
  }
  return params;
}

export function buildTurnSteerParams(options: TurnSteerOptions): TurnSteerParams {
  return {
    threadId: options.threadId,
    input: normalizeCodexTurnInput(options.input, options.text ?? ""),
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
    onImageGeneration: options.onImageGeneration,
    onCodexError: options.onCodexError,
    onTokenUsage: options.onTokenUsage,
    onGoalUpdated: options.onGoalUpdated,
    onGoalCleared: options.onGoalCleared,
    onPlanUpdated: options.onPlanUpdated
  });
  const onNotification = (notification: CodexNotificationMessage): void => {
    accumulator.record(notification);
  };
  const onServerRequest = (request: CodexRequestMessage): void => {
    handleTurnServerRequest(protocol, options, request);
  };

  protocol.on("notification", onNotification);
  protocol.on("serverRequest", onServerRequest);
  try {
    const response = await protocol.request<TurnStartResponse, TurnStartParams>(
      "turn/start",
      buildTurnStartParams(options),
      { timeoutMs: requestOptions.requestTimeoutMs }
    );
    if (response.turn?.id) {
      accumulator.setTurnId(response.turn.id, "response");
    }
    return await accumulator.wait(requestOptions.completionTimeoutMs);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new TwinnyError(toErrorMessage(error), "CODEX_TURN_FAILED", error);
  } finally {
    protocol.off("notification", onNotification);
    protocol.off("serverRequest", onServerRequest);
  }
}

export async function compactCodexThread(
  protocol: CodexProtocolClient,
  options: ThreadCompactStartOptions,
  requestOptions: TurnRequestOptions = {}
): Promise<CodexTurnResult> {
  const accumulator = new TurnOutputAccumulator(options.threadId, undefined, {
    onTurnStarted: options.onTurnStarted,
    onTokenUsage: options.onTokenUsage
  });
  const onNotification = (notification: CodexNotificationMessage): void => {
    accumulator.record(notification);
  };
  const onServerRequest = (request: CodexRequestMessage): void => {
    if (!requestMatchesThread(request, options.threadId)) {
      return;
    }
    protocol.respondError(request.id, {
      code: "TWINNY_UNSUPPORTED_SERVER_REQUEST",
      message: `Twinny does not implement Codex server request ${request.method} during compact`
    });
  };

  protocol.on("notification", onNotification);
  protocol.on("serverRequest", onServerRequest);
  try {
    await protocol.request<Record<string, never>, ThreadCompactStartParams>(
      "thread/compact/start",
      { threadId: options.threadId },
      { timeoutMs: requestOptions.requestTimeoutMs }
    );
    return await accumulator.wait(requestOptions.completionTimeoutMs);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new TwinnyError(toErrorMessage(error), "CODEX_TURN_FAILED", error);
  } finally {
    protocol.off("notification", onNotification);
    protocol.off("serverRequest", onServerRequest);
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
  private readonly generatedImages = new Map<string, CodexImageGeneration>();
  private readonly pendingAgentMessageCallbacks: Promise<void>[] = [];
  private agentMessageCallbackChain = Promise.resolve();
  private readonly startedAt = Date.now();
  private finalAnswerText: string | undefined;
  private turnId: string | undefined;
  private turnIdSource: TurnIdSource | undefined;
  private emittedTurnStartedId: string | undefined;
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
      onImageGeneration?: (image: CodexImageGeneration) => Promise<void> | void;
      onCodexError?: (error: CodexErrorNotification) => Promise<void> | void;
      onTokenUsage?: (usage: CodexThreadTokenUsageUpdate) => Promise<void> | void;
      onGoalUpdated?: (goal: ThreadGoal, turnId: string | null) => Promise<void> | void;
      onGoalCleared?: () => Promise<void> | void;
      onPlanUpdated?: (plan: CodexPlanUpdate) => Promise<void> | void;
    } = {}
  ) {
    this.turnId = turnId;
    this.turnIdSource = turnId ? "response" : undefined;
  }

  setTurnId(turnId: string, source: TurnIdSource = "notification"): void {
    const canReplaceResponseTurnId =
      source === "notification" &&
      this.turnIdSource === "response" &&
      this.turnId !== undefined &&
      this.turnId !== turnId;
    if (!this.turnId || canReplaceResponseTurnId) {
      this.turnId = turnId;
      this.turnIdSource = source;
    } else if (!this.turnIdSource) {
      this.turnIdSource = source;
    }
    if (this.emittedTurnStartedId !== this.turnId) {
      this.emittedTurnStartedId = this.turnId;
      void Promise.resolve(this.callbacks.onTurnStarted?.(this.turnId!)).catch((error: unknown) => {
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
      this.setTurnId(turnId, "notification");
    }
  }

  private recordItemCompleted(params: unknown): void {
    if (!isItemCompletedParams(params)) {
      return;
    }
    if (params.threadId !== this.threadId) {
      return;
    }
    if (params.turnId) {
      this.setTurnId(params.turnId, "notification");
    }
    if (this.turnId && params.turnId && params.turnId !== this.turnId) {
      return;
    }

    const plan = extractPlanUpdate(params);
    if (plan) {
      this.emitPlanUpdate(plan);
      return;
    }

    const item = extractAgentMessage(params.item);
    if (item) {
      this.assistantMessages.set(item.id, item.text);
      if (item.phase === "final_answer") {
        this.finalAnswerText = item.text;
      }
      this.emitAgentMessage(item);
      return;
    }

    const image = extractImageGeneration(params.item);
    if (image) {
      this.recordImageGeneration(image);
      this.emitImageGeneration(image);
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
    if (completedTurnId) {
      this.setTurnId(completedTurnId, "notification");
    }
    if (this.turnId && completedTurnId && completedTurnId !== this.turnId) {
      return;
    }

    for (const item of params.turn.items ?? []) {
      const message = extractAgentMessage(item);
      if (message) {
        this.assistantMessages.set(message.id, message.text);
        if (message.phase === "final_answer") {
          this.finalAnswerText = message.text;
        }
        continue;
      }
      const image = extractImageGeneration(item);
      if (image) {
        this.recordImageGeneration(image);
      }
    }

    this.completed = params;
    void this.resolveCompleted();
  }

  private recordError(params: unknown): void {
    if (!codexErrorMatchesRun(params, { threadId: this.threadId, turnId: this.turnId })) {
      return;
    }
    const error = parseCodexErrorNotification(params);
    this.emitCodexError(error);
    if (isRetryableTurnError(params)) {
      return;
    }
    this.completionError = new TwinnyError(error.message, "CODEX_TURN_FAILED", params);
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

  private recordGoalUpdated(params: unknown): void {
    if (!isRecord(params) || params.threadId !== this.threadId || !isThreadGoal(params.goal)) {
      return;
    }
    void Promise.resolve(this.callbacks.onGoalUpdated?.(params.goal, stringValue(params.turnId) ?? null)).catch((error: unknown) => {
      const parsedError =
        error instanceof Error ? error : new TwinnyError(toErrorMessage(error), "CODEX_THREAD_GOAL_CALLBACK_FAILED");
      this.completionError = parsedError;
      this.rejectWait?.(parsedError);
    });
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
  }

  private emitPlanUpdate(plan: CodexPlanUpdate): void {
    this.setTurnId(plan.turnId);
    void Promise.resolve(this.callbacks.onPlanUpdated?.(plan)).catch((error: unknown) => {
      const parsedError =
        error instanceof Error ? error : new TwinnyError(toErrorMessage(error), "CODEX_PLAN_CALLBACK_FAILED");
      this.completionError = parsedError;
      this.rejectWait?.(parsedError);
    });
  }

  private toResult(): CodexTurnResult {
    const turn = this.completed?.turn;
    const status = turn?.status === "failed" ? "failed" : turn?.status === "interrupted" ? "interrupted" : "completed";
    const generatedImages = Array.from(this.generatedImages.values());
    return {
      threadId: this.threadId,
      turnId: this.turnId,
      text: this.finalAnswerText ?? this.text,
      status,
      error: status === "failed" ? extractErrorMessage(turn?.error) : undefined,
      durationMs: typeof turn?.durationMs === "number" ? turn.durationMs : Date.now() - this.startedAt,
      ...(generatedImages.length > 0 ? { generatedImages } : {})
    };
  }

  private recordImageGeneration(image: CodexImageGeneration): void {
    this.generatedImages.set(image.id, image);
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

  private emitImageGeneration(image: CodexImageGeneration): void {
    if (!this.callbacks.onImageGeneration) {
      return;
    }
    const pending = this.agentMessageCallbackChain
      .then(() => this.callbacks.onImageGeneration?.(image))
      .catch((error: unknown) => {
        const parsedError =
          error instanceof Error ? error : new TwinnyError(toErrorMessage(error), "CODEX_IMAGE_GENERATION_CALLBACK_FAILED");
        this.completionError = parsedError;
        this.rejectWait?.(parsedError);
      });
    this.agentMessageCallbackChain = pending.then(() => undefined);
    this.pendingAgentMessageCallbacks.push(pending);
  }

  private emitCodexError(error: CodexErrorNotification): void {
    void Promise.resolve(this.callbacks.onCodexError?.(error)).catch(() => undefined);
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

function extractImageGeneration(item: unknown): CodexImageGeneration | undefined {
  if (!isRecord(item) || item.type !== "imageGeneration") {
    return undefined;
  }
  const id = stringValue(item.id);
  if (!id) {
    return undefined;
  }
  const status = stringValue(item.status);
  const savedPath = stringValue(item.savedPath) ?? stringValue(item.saved_path);
  const revisedPrompt = stringValue(item.revisedPrompt) ?? stringValue(item.revised_prompt);
  const result = stringValue(item.result);
  return {
    id,
    ...(status ? { status } : {}),
    ...(savedPath ? { savedPath } : {}),
    ...(revisedPrompt ? { revisedPrompt } : {}),
    ...(result ? { result } : {})
  };
}

function extractPlanUpdate(params: ItemCompletedParams): CodexPlanUpdate | undefined {
  const turnId = stringValue(params.turnId);
  if (!turnId || !isRecord(params.item) || params.item.type !== "plan") {
    return undefined;
  }
  const text = stringValue(params.item.text);
  if (text === undefined) {
    return undefined;
  }
  return {
    threadId: params.threadId,
    turnId,
    explanation: text,
    plan: []
  };
}

export function handleTurnServerRequest(
  protocol: CodexProtocolClient,
  options: TurnStartOptions,
  request: CodexRequestMessage
): void {
  if (request.method === "item/tool/call") {
    handleDynamicToolCallRequest(protocol, options, request);
    return;
  }
  if (request.method !== "item/tool/requestUserInput") {
    if (requestMatchesThread(request, options.threadId)) {
      protocol.respondError(request.id, {
        code: "TWINNY_UNSUPPORTED_SERVER_REQUEST",
        message: `Twinny does not implement Codex server request ${request.method}`
      });
    }
    return;
  }
  const params = parseRequestUserInputParams(request.params);
  if (!params || params.threadId !== options.threadId) {
    return;
  }
  if (!options.onRequestUserInput) {
    protocol.respondError(request.id, {
      code: "TWINNY_UNSUPPORTED_SERVER_REQUEST",
      message: "Twinny does not implement item/tool/requestUserInput for this turn"
    });
    return;
  }

  let settled = false;
  const responder: CodexRequestUserInputResponder = {
    respond: (response) => {
      if (settled) {
        return;
      }
      settled = true;
      protocol.respond(request.id, response);
    },
    reject: (error) => {
      if (settled) {
        return;
      }
      settled = true;
      protocol.respondError(request.id, {
        code: "TWINNY_REQUEST_USER_INPUT_FAILED",
        message: typeof error === "string" ? error : error.message
      });
    }
  };

  void Promise.resolve(
    options.onRequestUserInput(
      {
        requestId: request.id,
        params
      },
      responder
    )
  ).catch((error: unknown) => {
    responder.reject(error instanceof Error ? error : toErrorMessage(error));
  });
}

function handleDynamicToolCallRequest(
  protocol: CodexProtocolClient,
  options: TurnStartOptions,
  request: CodexRequestMessage
): void {
  const params = parseDynamicToolCallParams(request.params);
  if (!params) {
    if (requestMatchesThread(request, options.threadId)) {
      protocol.respondError(request.id, {
        code: "TWINNY_INVALID_DYNAMIC_TOOL_CALL",
        message: "Invalid Codex dynamic tool call request"
      });
    }
    return;
  }
  if (params.threadId !== options.threadId) {
    return;
  }
  if (params.namespace !== "twinny") {
    protocol.respondError(request.id, {
      code: "TWINNY_UNSUPPORTED_SERVER_REQUEST",
      message: `Twinny does not implement dynamic tool ${params.namespace ? `${params.namespace}.` : ""}${params.tool}`
    });
    return;
  }

  if (params.tool === "set_thread_name") {
    handleSetThreadNameToolCall(protocol, options, request.id, params);
    return;
  }

  if (!options.onDynamicToolCall) {
    protocol.respondError(request.id, {
      code: "TWINNY_UNSUPPORTED_SERVER_REQUEST",
      message: `Twinny does not implement twinny.${params.tool} for this turn`
    });
    return;
  }

  const parsed = parseTwinnyDynamicToolRequest(request.id, params);
  if (typeof parsed === "string") {
    protocol.respond(request.id, dynamicToolTextResponse(false, parsed));
    return;
  }

  void Promise.resolve(options.onDynamicToolCall(parsed)).then(
    (response) => protocol.respond(request.id, response),
    (error: unknown) => {
      protocol.respond(
        request.id,
        dynamicToolJsonResponse(false, {
          ok: false,
          error: { code: "TWINNY_DYNAMIC_TOOL_FAILED", message: toErrorMessage(error) }
        })
      );
    }
  );
}

function handleSetThreadNameToolCall(
  protocol: CodexProtocolClient,
  options: TurnStartOptions,
  requestId: string | number,
  params: DynamicToolCallParams
): void {
  if (!options.onSetThreadName) {
    protocol.respondError(requestId, {
      code: "TWINNY_UNSUPPORTED_SERVER_REQUEST",
      message: "Twinny does not implement twinny.set_thread_name for this turn"
    });
    return;
  }

  const name = parseSetThreadNameArguments(params.arguments);
  if (!name) {
    protocol.respond(requestId, dynamicToolTextResponse(false, "Invalid thread name: expected a non-empty name string."));
    return;
  }

  void Promise.resolve(
    options.onSetThreadName({
      requestId,
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId,
      name,
      rawArguments: params.arguments
    })
  ).then(
    (response) => protocol.respond(requestId, response),
    (error: unknown) => {
      protocol.respond(
        requestId,
        dynamicToolTextResponse(false, `Failed to update thread name: ${toErrorMessage(error)}`)
      );
    }
  );
}

function requestMatchesThread(request: CodexRequestMessage, threadId: string): boolean {
  return isRecord(request.params) && request.params.threadId === threadId;
}

interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

function parseDynamicToolCallParams(value: unknown): DynamicToolCallParams | undefined {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.callId !== "string" ||
    typeof value.tool !== "string"
  ) {
    return undefined;
  }
  if (value.namespace !== null && typeof value.namespace !== "string") {
    return undefined;
  }
  return {
    threadId: value.threadId,
    turnId: value.turnId,
    callId: value.callId,
    namespace: value.namespace,
    tool: value.tool,
    arguments: value.arguments
  };
}

function parseSetThreadNameArguments(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.name !== "string") {
    return undefined;
  }
  const name = value.name.replace(/\s+/g, " ").trim();
  return name || undefined;
}

function parseTwinnyDynamicToolRequest(
  requestId: string | number,
  params: DynamicToolCallParams
): CodexTwinnyDynamicToolRequest | string {
  switch (params.tool) {
    case "list_threads": {
      const args = isRecord(params.arguments) ? params.arguments : {};
      const page = optionalInteger(args.page, 1, 1, Number.MAX_SAFE_INTEGER);
      const pageSize = optionalInteger(args.page_size, 20, 1, 100);
      if (page === undefined || pageSize === undefined) {
        return "Invalid list_threads arguments: page must be >= 1 and page_size must be 1..100.";
      }
      return {
        requestId,
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        tool: "list_threads",
        page,
        pageSize,
        rawArguments: params.arguments
      };
    }
    case "new_thread": {
      const args = isRecord(params.arguments) ? params.arguments : {};
      const workspace = trimmedString(args.workspace);
      const model = trimmedString(args.model);
      const effort = trimmedString(args.effort);
      const fork = optionalBoolean(args.fork, false);
      const mode = parseThreadMode(args.mode, "default");
      const name = trimmedString(args.name);
      const initialMessage = optionalString(args.initial_message, "");
      if (
        fork === undefined ||
        mode === undefined ||
        initialMessage === undefined ||
        (args.name !== undefined && (!name || name.length > 80))
      ) {
        return "Invalid new_thread arguments: workspace/model/effort/name/initial_message must be strings, fork must be boolean, and mode must be default or plan.";
      }
      return {
        requestId,
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        tool: "new_thread",
        ...(workspace ? { workspace } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        fork,
        mode,
        ...(name ? { name } : {}),
        initialMessage,
        rawArguments: params.arguments
      };
    }
    case "wait_for_threads": {
      if (!isRecord(params.arguments)) {
        return "Invalid wait_for_threads arguments: expected an object.";
      }
      const targetThreadIds = parseThreadIds(params.arguments.thread_ids);
      const timeoutMs = optionalInteger(params.arguments.timeout_ms, 300_000, 0, 3_600_000);
      if (!targetThreadIds || timeoutMs === undefined) {
        return "Invalid wait_for_threads arguments: thread_ids must be a non-empty string array and timeout_ms must be 0..3600000.";
      }
      return {
        requestId,
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        tool: "wait_for_threads",
        targetThreadIds,
        timeoutMs,
        rawArguments: params.arguments
      };
    }
    case "send_thread_ref": {
      if (!isRecord(params.arguments)) {
        return "Invalid send_thread_ref arguments: expected an object.";
      }
      const targetThreadId = trimmedString(params.arguments.thread_id);
      if (!targetThreadId) {
        return "Invalid send_thread_ref arguments: thread_id is required.";
      }
      return {
        requestId,
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        tool: "send_thread_ref",
        targetThreadId,
        rawArguments: params.arguments
      };
    }
    case "tell_thread": {
      if (!isRecord(params.arguments)) {
        return "Invalid tell_thread arguments: expected an object.";
      }
      const targetThreadId = trimmedString(params.arguments.thread_id);
      const message = trimmedString(params.arguments.msg);
      if (!targetThreadId || !message) {
        return "Invalid tell_thread arguments: thread_id and msg are required.";
      }
      return {
        requestId,
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        tool: "tell_thread",
        targetThreadId,
        message,
        rawArguments: params.arguments
      };
    }
    case "add_cron": {
      if (!isRecord(params.arguments)) {
        return "Invalid add_cron arguments: expected an object.";
      }
      const cronExpression = trimmedString(params.arguments.cron_exp);
      const message = trimmedString(params.arguments.msg);
      const targetThreadId = trimmedString(params.arguments.thread_id);
      if (!cronExpression || !message) {
        return "Invalid add_cron arguments: cron_exp and msg are required.";
      }
      return {
        requestId,
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        tool: "add_cron",
        cronExpression,
        message,
        ...(targetThreadId ? { targetThreadId } : {}),
        rawArguments: params.arguments
      };
    }
    case "list_cron": {
      if (params.arguments !== undefined && params.arguments !== null && !isRecord(params.arguments)) {
        return "Invalid list_cron arguments: expected an object.";
      }
      return {
        requestId,
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        tool: "list_cron",
        rawArguments: params.arguments
      };
    }
    case "del_cron": {
      if (!isRecord(params.arguments)) {
        return "Invalid del_cron arguments: expected an object.";
      }
      const cronId = requiredInteger(params.arguments.cron_id, 1, Number.MAX_SAFE_INTEGER);
      if (cronId === undefined) {
        return "Invalid del_cron arguments: cron_id must be an integer >= 1.";
      }
      return {
        requestId,
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        tool: "del_cron",
        cronId,
        rawArguments: params.arguments
      };
    }
    case "create_conversation": {
      if (!isRecord(params.arguments)) {
        return "Invalid create_conversation arguments: expected an object.";
      }
      const name = trimmedString(params.arguments.name);
      if (!name || name.length > 80) {
        return "Invalid create_conversation arguments: name is required and must be at most 80 characters.";
      }
      const memberOpenIds = parseMemberOpenIds(params.arguments.member_open_ids);
      if (!memberOpenIds) {
        return "Invalid create_conversation arguments: member_open_ids must contain at most 50 non-empty strings.";
      }
      const responseMode = parseResponseMode(params.arguments.response_mode);
      if (params.arguments.response_mode !== undefined && !responseMode) {
        return "Invalid create_conversation arguments: response_mode is unsupported.";
      }
      const profile = trimmedString(params.arguments.profile);
      if (profile !== undefined && profile.length > 64) {
        return "Invalid create_conversation arguments: profile must be at most 64 characters.";
      }
      return {
        requestId,
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        tool: "create_conversation",
        name,
        memberOpenIds,
        ...(responseMode ? { responseMode } : {}),
        ...(profile ? { profile } : {}),
        rawArguments: params.arguments
      };
    }
    default:
      return `Twinny does not implement dynamic tool twinny.${params.tool}`;
  }
}

function requiredInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

function optionalInteger(value: unknown, defaultValue: number, min: number, max: number): number | undefined {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

function optionalBoolean(value: unknown, defaultValue: boolean): boolean | undefined {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  return typeof value === "boolean" ? value : undefined;
}

function optionalString(value: unknown, defaultValue: string): string | undefined {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  return typeof value === "string" ? value : undefined;
}

function parseThreadMode(value: unknown, defaultValue: CodexThreadMode): CodexThreadMode | undefined {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  return value === "default" || value === "plan" ? value : undefined;
}

function parseThreadIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const ids: string[] = [];
  for (const item of value) {
    const id = trimmedString(item);
    if (!id) {
      return undefined;
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseMemberOpenIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 50) {
    return undefined;
  }
  const ids: string[] = [];
  for (const item of value) {
    const id = trimmedString(item);
    if (!id) {
      return undefined;
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function parseResponseMode(value: unknown): CodexCreateConversationToolRequest["responseMode"] | undefined {
  return value === "all" || value === "all_at" || value === "owner" || value === "owner_at" || value === "none"
    ? value
    : undefined;
}

export function dynamicToolTextResponse(success: boolean, text: string): CodexDynamicToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }]
  };
}

export function dynamicToolJsonResponse(success: boolean, value: unknown): CodexDynamicToolCallResponse {
  return dynamicToolTextResponse(success, JSON.stringify(value));
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseRequestUserInputParams(value: unknown): CodexRequestUserInputParams | undefined {
  if (!isRecord(value) || typeof value.threadId !== "string" || typeof value.turnId !== "string") {
    return undefined;
  }
  if (typeof value.itemId !== "string" || !Array.isArray(value.questions)) {
    return undefined;
  }
  const questions = value.questions.map(parseRequestUserInputQuestion);
  if (questions.some((question) => question === undefined)) {
    return undefined;
  }
  return {
    threadId: value.threadId,
    turnId: value.turnId,
    itemId: value.itemId,
    questions: questions as CodexRequestUserInputParams["questions"]
  };
}

function parseRequestUserInputQuestion(value: unknown): CodexRequestUserInputParams["questions"][number] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, header, question, isOther, isSecret, options } = value;
  if (
    typeof id !== "string" ||
    typeof header !== "string" ||
    typeof question !== "string" ||
    typeof isOther !== "boolean" ||
    typeof isSecret !== "boolean"
  ) {
    return undefined;
  }
  if (options !== null && options !== undefined && !Array.isArray(options)) {
    return undefined;
  }
  const parsedOptions = (options ?? null) === null
    ? null
    : (options as unknown[]).map((option) => {
        if (!isRecord(option) || typeof option.label !== "string" || typeof option.description !== "string") {
          return undefined;
        }
        return { label: option.label, description: option.description };
      });
  if (Array.isArray(parsedOptions) && parsedOptions.some((option) => option === undefined)) {
    return undefined;
  }
  return {
    id,
    header,
    question,
    isOther,
    isSecret,
    options: parsedOptions as CodexRequestUserInputParams["questions"][number]["options"]
  };
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

export function extractTotalTokens(params: Record<string, unknown>): number | undefined {
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

export function codexErrorMatchesRun(value: unknown, run: { threadId: string; turnId?: string }): boolean {
  if (!isRecord(value)) {
    return true;
  }
  const threadId = stringValue(value.threadId) ?? stringValue(value.thread_id);
  if (threadId && threadId !== run.threadId) {
    return false;
  }
  const turnId = stringValue(value.turnId) ?? stringValue(value.turn_id);
  return !turnId || !run.turnId || turnId === run.turnId;
}

export function isRetryableTurnError(value: unknown): boolean {
  return isRecord(value) && value.willRetry === true;
}

export function extractCodexErrorNotificationMessage(value: unknown): string {
  return parseCodexErrorNotification(value).message;
}

export function parseCodexErrorNotification(value: unknown): CodexErrorNotification {
  if (!isRecord(value)) {
    return {
      message: "Codex app-server reported an error",
      willRetry: null,
      codexErrorInfo: null,
      additionalDetails: null,
      raw: value
    };
  }
  const nestedError = isRecord(value.error) ? value.error : undefined;
  return {
    threadId: stringValue(value.threadId) ?? stringValue(value.thread_id),
    turnId: stringValue(value.turnId) ?? stringValue(value.turn_id),
    message: stringValue(value.message) ??
      stringValue(nestedError?.message) ??
      stringValue(value.additionalDetails) ??
      stringValue(value.additional_details) ??
      "Codex app-server reported an error",
    willRetry: typeof value.willRetry === "boolean" ? value.willRetry : null,
    codexErrorInfo: codexErrorInfoValue(nestedError?.codexErrorInfo),
    additionalDetails: stringValue(value.additionalDetails) ??
      stringValue(value.additional_details) ??
      stringValue(nestedError?.additionalDetails) ??
      stringValue(nestedError?.additional_details) ??
      null,
    raw: value
  };
}

function codexErrorInfoValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).filter((key) => key.length > 0).sort();
    return keys.length > 0 ? keys.join(",") : null;
  }
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
