import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import type { Logger } from "pino";
import { TwinnyError, toErrorMessage } from "../errors.js";
import type { TwinnyConfig } from "../types.js";
import { TWINNY_VERSION } from "../version.js";
import { telemetryHashId } from "./hash.js";
import { PostHogTelemetryReporter } from "./posthog.js";
import {
  captureTelemetryBestEffort,
  captureTelemetryExceptionBestEffort,
  NullTelemetryReporter,
  type TelemetryProperties,
  type TelemetryReporter
} from "./reporter.js";

export interface TelemetryClient {
  readonly runtimeId: string;
  capture(event: string, properties?: TelemetryProperties, options?: TelemetryCaptureOptions): void;
  captureError(error: unknown, context: TelemetryErrorContext): void;
  flush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
  hashId(kind: string, raw: string | null | undefined): string | null;
}

export interface TelemetryCaptureOptions {
  insertId?: string;
  codexVersion?: string | null;
}

export interface TelemetryErrorContext extends TelemetryCaptureOptions {
  errorType: string;
  errorSite: string;
  operation?: string;
  fatal?: boolean;
  conversationKey?: string;
  codexThreadId?: string;
  codexTurnId?: string;
  larkSenderOpenId?: string;
  larkEventId?: string;
  larkMessageId?: string;
  properties?: TelemetryProperties;
}

export interface TwinnyTelemetryClientOptions {
  runtimeId?: string;
  now?: () => number;
  reporter?: TelemetryReporter;
  logger?: Pick<Logger, "warn">;
  codexVersion?: () => string | null | undefined;
  osVersion?: string;
  timezoneOffsetMinutes?: (timestampMs: number) => number;
  fetch?: typeof fetch;
}

export class TwinnyTelemetryClient implements TelemetryClient {
  readonly runtimeId: string;
  private readonly now: () => number;
  private readonly reporter: TelemetryReporter;
  private readonly logger?: Pick<Logger, "warn">;
  private readonly codexVersion?: () => string | null | undefined;
  private readonly osVersion: string;
  private readonly timezoneOffsetMinutes: (timestampMs: number) => number;
  private nextInsertId = 0;

  constructor(
    private readonly config: TwinnyConfig,
    options: TwinnyTelemetryClientOptions = {}
  ) {
    this.runtimeId = options.runtimeId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.reporter = options.reporter ?? createTelemetryReporter(config, {
      runtimeId: this.runtimeId,
      fetch: options.fetch
    });
    this.logger = options.logger;
    this.codexVersion = options.codexVersion;
    this.osVersion = options.osVersion ?? readOsVersion();
    this.timezoneOffsetMinutes = options.timezoneOffsetMinutes ?? readTimezoneOffsetMinutes;
  }

  capture(event: string, properties: TelemetryProperties = {}, options: TelemetryCaptureOptions = {}): void {
    captureTelemetryBestEffort(
      this.reporter,
      event,
      {
        ...this.commonProperties(event, options),
        ...properties
      },
      this.logger
    );
  }

  captureError(error: unknown, context: TelemetryErrorContext): void {
    const errorProperties = this.errorTelemetryProperties(error, context);
    this.capture(
      "twinny_error",
      errorProperties,
      context
    );
    captureTelemetryExceptionBestEffort(
      this.reporter,
      errorForExceptionTracking(error, context),
      {
        ...this.commonProperties("$exception", {
          ...context,
          insertId: context.insertId ? `${context.insertId}:exception` : undefined
        }),
        ...errorProperties,
        telemetry_error_event: "twinny_error"
      },
      this.logger
    );
  }

  async flush(): Promise<void> {
    await this.drainTelemetry("flush");
  }

  async shutdown(): Promise<void> {
    await this.drainTelemetry("shutdown");
  }

  hashId(kind: string, raw: string | null | undefined): string | null {
    return raw ? telemetryHashId(this.config.homeIdentity.telemetryHashSalt, kind, raw) : null;
  }

  private errorTelemetryProperties(error: unknown, context: TelemetryErrorContext): TelemetryProperties {
    const stack = normalizedStack(error);
    return {
      error_name: errorName(error),
      error_code: errorCode(error),
      error_type: context.errorType,
      error_site: context.errorSite,
      code_location: codeLocation(error),
      fatal: context.fatal ?? false,
      operation: context.operation ?? null,
      conversation_id: this.hashId("conversation", context.conversationKey),
      thread_id: this.hashId("codex_thread", context.codexThreadId),
      turn_id: this.hashId("codex_turn", context.codexTurnId),
      sender_id: this.hashId("lark_open_id", context.larkSenderOpenId),
      message_event_id: this.hashId("lark_event", context.larkEventId),
      message_id: this.hashId("lark_message", context.larkMessageId),
      error_message_hash: this.hashId("error_message", toErrorMessage(error)),
      error_message_redacted: null,
      stack_hash: stack ? this.hashId("error_stack", stack) : null,
      ...(context.properties ?? {})
    };
  }

  private commonProperties(event: string, options: TelemetryCaptureOptions): TelemetryProperties {
    const eventTsMs = this.now();
    const timezoneOffsetMinutes = this.timezoneOffsetMinutes(eventTsMs);
    return {
      schema_version: 1,
      install_id: this.hashId("install", this.config.homeIdentity.random),
      runtime_id: this.runtimeId,
      event_ts_ms: eventTsMs,
      twinny_version: TWINNY_VERSION,
      codex_version: options.codexVersion ?? this.codexVersion?.() ?? null,
      os_platform: os.platform(),
      os_arch: os.arch(),
      os_version: this.osVersion,
      timezone_offset: formatTimezoneOffset(timezoneOffsetMinutes),
      timezone_offset_minutes: timezoneOffsetMinutes,
      node_version: process.versions.node,
      lark_brand: this.config.auth.larkBrand,
      profile_count: Object.keys(this.config.profiles).length,
      $insert_id: options.insertId ?? `${event}:${this.runtimeId}:${this.nextInsertId++}`
    };
  }

  private async drainTelemetry(method: "flush" | "shutdown"): Promise<void> {
    const drain = this.reporter[method] ?? this.reporter.flush;
    if (!drain) {
      return;
    }
    try {
      await drain.call(this.reporter);
    } catch (error) {
      this.logger?.warn({ error }, `failed to ${method} telemetry`);
    }
  }
}

export function createTwinnyTelemetryClient(config: TwinnyConfig, options: TwinnyTelemetryClientOptions = {}): TwinnyTelemetryClient {
  return new TwinnyTelemetryClient(config, options);
}

export function memoryUsageTelemetryProperties(): TelemetryProperties {
  const memory = process.memoryUsage();
  return {
    memory_rss_mb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
    heap_used_mb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10
  };
}

function createTelemetryReporter(
  config: TwinnyConfig,
  options: { runtimeId: string; fetch?: typeof fetch }
): TelemetryReporter {
  const telemetry = config.telemetry;
  if (!telemetry?.enabled || !telemetry.posthogProjectToken) {
    return new NullTelemetryReporter();
  }
  return new PostHogTelemetryReporter({
    apiKey: telemetry.posthogProjectToken,
    host: telemetry.posthogHost,
    distinctId: telemetryHashId(config.homeIdentity.telemetryHashSalt, "install", config.homeIdentity.random),
    fetch: options.fetch
  });
}

function readOsVersion(): string {
  if (os.platform() === "darwin") {
    try {
      return execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 500 }).trim();
    } catch {
      return os.release();
    }
  }
  return typeof os.version === "function" ? os.version() : os.release();
}

function readTimezoneOffsetMinutes(timestampMs: number): number {
  return -new Date(timestampMs).getTimezoneOffset();
}

function formatTimezoneOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function errorCode(error: unknown): string | null {
  if (error instanceof TwinnyError) {
    return error.code;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" || typeof code === "number" ? String(code) : null;
  }
  return null;
}

function normalizedStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function codeLocation(error: unknown): string | null {
  const stack = normalizedStack(error);
  if (!stack) {
    return null;
  }
  for (const line of stack.split("\n")) {
    const match = /(?:\(|\s)([^()\s]*src\/[^():]+:\d+:\d+)\)?$/.exec(line.trim());
    if (match?.[1]) {
      const index = match[1].lastIndexOf("src/");
      return index >= 0 ? match[1].slice(index) : match[1];
    }
  }
  return null;
}

function errorForExceptionTracking(error: unknown, context: TelemetryErrorContext): Error {
  const message = sanitizedExceptionMessage(error, context);
  const exception = new Error(message);
  exception.name = errorName(error);
  const stack = normalizedStack(error);
  if (stack) {
    const lines = stack.split("\n");
    lines[0] = `${exception.name}: ${message}`;
    exception.stack = lines.join("\n");
  }
  return exception;
}

function sanitizedExceptionMessage(error: unknown, context: TelemetryErrorContext): string {
  const parts = [context.errorType, context.errorSite, errorCode(error)].filter((part): part is string => Boolean(part));
  return parts.join(":");
}
