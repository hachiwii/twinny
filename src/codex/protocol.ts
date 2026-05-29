import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { TwinnyError, toErrorMessage } from "../errors.js";
import { TWINNY_VERSION } from "../version.js";

export type CodexRequestId = string | number;

export interface CodexRequestMessage<TParams = unknown> {
  id: CodexRequestId;
  method: string;
  params?: TParams;
}

export interface CodexNotificationMessage<TParams = unknown> {
  method: string;
  params?: TParams;
}

export interface CodexResponseError {
  code?: number | string;
  message: string;
  data?: unknown;
}

export interface CodexResponseMessage<TResult = unknown> {
  id: CodexRequestId;
  result?: TResult;
  error?: CodexResponseError;
}

export type CodexIncomingMessage =
  | CodexResponseMessage
  | CodexRequestMessage
  | CodexNotificationMessage;

export interface InitializeParams {
  clientInfo: {
    name: string;
    title: string | null;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | undefined;
}

export interface CodexProtocolClientOptions {
  requestTimeoutMs?: number;
  requestIdPrefix?: string;
}

export interface CodexProtocolClientEvents {
  notification: [message: CodexNotificationMessage];
  serverRequest: [message: CodexRequestMessage];
  response: [message: CodexResponseMessage];
  message: [message: CodexIncomingMessage];
  error: [error: Error];
  close: [];
}

export declare interface CodexProtocolClient {
  on<K extends keyof CodexProtocolClientEvents>(
    event: K,
    listener: (...args: CodexProtocolClientEvents[K]) => void
  ): this;
  once<K extends keyof CodexProtocolClientEvents>(
    event: K,
    listener: (...args: CodexProtocolClientEvents[K]) => void
  ): this;
  off<K extends keyof CodexProtocolClientEvents>(
    event: K,
    listener: (...args: CodexProtocolClientEvents[K]) => void
  ): this;
  emit<K extends keyof CodexProtocolClientEvents>(
    event: K,
    ...args: CodexProtocolClientEvents[K]
  ): boolean;
}

export class CodexProtocolClient extends EventEmitter {
  private readonly pending = new Map<CodexRequestId, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly requestIdPrefix: string;
  private nextRequestId = 1;
  private readLoopDone: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable,
    options: CodexProtocolClientOptions = {}
  ) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.requestIdPrefix = options.requestIdPrefix ?? "twinny";
  }

  start(): void {
    if (this.readLoopDone) {
      return;
    }
    this.readLoopDone = this.readLoop().catch((error: unknown) => {
      const parsedError =
        error instanceof Error ? error : new TwinnyError(toErrorMessage(error), "CODEX_PROTOCOL_READ_ERROR");
      this.failAllPending(parsedError);
      this.emit("error", parsedError);
    });
  }

  async waitForClose(): Promise<void> {
    await this.readLoopDone;
  }

  async initialize(params: InitializeParams): Promise<InitializeResponse> {
    const response = await this.request<InitializeResponse>("initialize", params);
    this.notify("initialized");
    return response;
  }

  request<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
    options: { timeoutMs?: number } = {}
  ): Promise<TResult> {
    if (this.closed) {
      return Promise.reject(new TwinnyError("Codex protocol connection is closed", "CODEX_PROTOCOL_CLOSED"));
    }

    const id = this.allocateRequestId();
    const message: CodexRequestMessage<TParams> =
      params === undefined ? { id, method } : { id, method, params };

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new TwinnyError(`Timed out waiting for Codex response to ${method}`, "CODEX_REQUEST_TIMEOUT"));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { method, resolve, reject, timeout });
    });

    try {
      this.writeJson(message);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending?.timeout) {
        clearTimeout(pending.timeout);
      }
      this.pending.delete(id);
      throw error;
    }

    return promise as Promise<TResult>;
  }

  notify<TParams = unknown>(method: string, params?: TParams): void {
    const message: CodexNotificationMessage<TParams> =
      params === undefined ? { method } : { method, params };
    this.writeJson(message);
  }

  respond<TResult = unknown>(id: CodexRequestId, result: TResult): void {
    this.writeJson({ id, result });
  }

  respondError(id: CodexRequestId, error: CodexResponseError): void {
    this.writeJson({ id, error });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.writable.end();
    this.failAllPending(new TwinnyError("Codex protocol connection closed", "CODEX_PROTOCOL_CLOSED"));
  }

  private allocateRequestId(): string {
    return `${this.requestIdPrefix}-${this.nextRequestId++}`;
  }

  private async readLoop(): Promise<void> {
    let buffer = "";
    this.readable.setEncoding("utf8");
    for await (const chunk of this.readable) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        this.handleLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer.trim().length > 0) {
      this.handleLine(buffer);
    }
    this.closed = true;
    this.failAllPending(new TwinnyError("Codex protocol stream ended", "CODEX_PROTOCOL_CLOSED"));
    this.emit("close");
  }

  private handleLine(line: string): void {
    if (this.closed) {
      return;
    }

    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      this.emit(
        "error",
        new TwinnyError(`Invalid Codex protocol JSON line: ${toErrorMessage(error)}`, "CODEX_PROTOCOL_PARSE_ERROR")
      );
      return;
    }

    if (!isRecord(parsed)) {
      this.emit("error", new TwinnyError("Codex protocol message is not an object", "CODEX_PROTOCOL_PARSE_ERROR"));
      return;
    }

    const message = parsed as unknown as CodexIncomingMessage;
    this.emit("message", message);

    if (isResponseMessage(message)) {
      this.handleResponse(message);
      return;
    }

    if (isRequestMessage(message)) {
      this.emit("serverRequest", message);
      return;
    }

    if (isNotificationMessage(message)) {
      this.emit("notification", message);
      return;
    }

    this.emit("error", new TwinnyError("Unknown Codex protocol message shape", "CODEX_PROTOCOL_PARSE_ERROR"));
  }

  private handleResponse(message: CodexResponseMessage): void {
    this.emit("response", message);
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.emit(
        "error",
        new TwinnyError(`Received response for unknown Codex request id ${String(message.id)}`, "CODEX_UNKNOWN_RESPONSE")
      );
      return;
    }

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new TwinnyError(message.error.message, "CODEX_REQUEST_FAILED", message.error));
      return;
    }
    pending.resolve(message.result);
  }

  private writeJson(message: unknown): void {
    if (this.closed) {
      throw new TwinnyError("Codex protocol connection is closed", "CODEX_PROTOCOL_CLOSED");
    }
    const line = `${JSON.stringify(message)}\n`;
    if (!this.writable.write(line, "utf8")) {
      this.writable.once("drain", () => undefined);
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createInitializeParams(
  versionOrClientInfo: string | InitializeParams["clientInfo"] = TWINNY_VERSION
): InitializeParams {
  const clientInfo =
    typeof versionOrClientInfo === "string"
      ? {
          name: "twinny",
          title: "Twinny",
          version: versionOrClientInfo
        }
      : versionOrClientInfo;
  return {
    clientInfo,
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: null
    }
  };
}

export function isResponseMessage(message: CodexIncomingMessage): message is CodexResponseMessage {
  return "id" in message && ("result" in message || "error" in message) && !("method" in message);
}

export function isRequestMessage(message: CodexIncomingMessage): message is CodexRequestMessage {
  return "id" in message && "method" in message && typeof message.method === "string";
}

export function isNotificationMessage(message: CodexIncomingMessage): message is CodexNotificationMessage {
  return !("id" in message) && "method" in message && typeof message.method === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
