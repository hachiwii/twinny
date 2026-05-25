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
  NullTelemetryReporter,
  type TelemetryProperties,
  type TelemetryReporter
} from "./reporter.js";

export interface TelemetryClient {
  readonly runtimeId: string;
  capture(event: string, properties?: TelemetryProperties, options?: TelemetryCaptureOptions): void;
  captureError(error: unknown, context: TelemetryErrorContext): void;
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
  fetch?: typeof fetch;
}

export class TwinnyTelemetryClient implements TelemetryClient {
  readonly runtimeId: string;
  private readonly now: () => number;
  private readonly reporter: TelemetryReporter;
  private readonly logger?: Pick<Logger, "warn">;
  private readonly codexVersion?: () => string | null | undefined;
  private readonly osVersion: string;
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
    this.capture(
      "twinny_error",
      {
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
        stack_hash: normalizedStack(error) ? this.hashId("error_stack", normalizedStack(error)) : null,
        ...(context.properties ?? {})
      },
      context
    );
  }

  hashId(kind: string, raw: string | null | undefined): string | null {
    return raw ? telemetryHashId(this.config.homeIdentity.telemetryHashSalt, kind, raw) : null;
  }

  private commonProperties(event: string, options: TelemetryCaptureOptions): TelemetryProperties {
    return {
      schema_version: 1,
      install_id: this.hashId("install", this.config.homeIdentity.random),
      runtime_id: this.runtimeId,
      event_ts_ms: this.now(),
      twinny_version: TWINNY_VERSION,
      codex_version: options.codexVersion ?? this.codexVersion?.() ?? null,
      os_platform: os.platform(),
      os_arch: os.arch(),
      os_version: this.osVersion,
      node_version: process.versions.node,
      lark_brand: this.config.auth.larkBrand,
      profile_count: Object.keys(this.config.profiles).length,
      $insert_id: options.insertId ?? `${event}:${this.runtimeId}:${this.nextInsertId++}`
    };
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
