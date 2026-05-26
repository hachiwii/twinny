import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { toErrorMessage } from "../errors.js";
import type { TelemetryProperties } from "../telemetry/index.js";
import type { RuntimePaths } from "../types.js";

export const startupErrorTelemetryThrottleMs = 60 * 60 * 1000;

const stateVersion = 1;
const maxTrackedErrors = 50;
const stateFileName = "startup-error-telemetry.json";

interface StartupErrorTelemetryContext {
  errorType: string;
  errorSite: string;
  operation?: string;
}

interface StartupErrorTelemetryEntry {
  firstSeenAt: number;
  lastSeenAt: number;
  lastCapturedAt: number;
  captureCount: number;
  suppressedSinceLastCapture: number;
  totalSuppressed: number;
}

interface StartupErrorTelemetryState {
  version: typeof stateVersion;
  errors: Record<string, StartupErrorTelemetryEntry>;
}

export interface StartupErrorTelemetryDecision {
  capture: boolean;
  fingerprint: string;
  insertId: string;
  properties: TelemetryProperties;
  throttleStateError?: unknown;
}

export interface RecordStartupErrorTelemetryOptions {
  now?: () => number;
  throttleMs?: number;
}

export async function recordStartupErrorTelemetryAttempt(
  paths: Pick<RuntimePaths, "runtimeDir">,
  error: unknown,
  context: StartupErrorTelemetryContext,
  options: RecordStartupErrorTelemetryOptions = {}
): Promise<StartupErrorTelemetryDecision> {
  const now = options.now?.() ?? Date.now();
  const throttleMs = options.throttleMs ?? startupErrorTelemetryThrottleMs;
  const fingerprint = startupErrorFingerprint(error, context);
  const insertId = startupErrorTelemetryInsertId(fingerprint, now, throttleMs);

  try {
    const stateFile = path.join(paths.runtimeDir, stateFileName);
    const state = await readStartupErrorTelemetryState(stateFile);
    const existing = state.errors[fingerprint];
    const entry: StartupErrorTelemetryEntry = existing ?? {
      firstSeenAt: now,
      lastSeenAt: now,
      lastCapturedAt: 0,
      captureCount: 0,
      suppressedSinceLastCapture: 0,
      totalSuppressed: 0
    };
    const capture = entry.lastCapturedAt === 0 || now - entry.lastCapturedAt >= throttleMs;
    const suppressedSinceLastCapture = entry.suppressedSinceLastCapture;

    entry.lastSeenAt = now;
    if (capture) {
      entry.lastCapturedAt = now;
      entry.captureCount += 1;
      entry.suppressedSinceLastCapture = 0;
    } else {
      entry.suppressedSinceLastCapture += 1;
      entry.totalSuppressed += 1;
    }

    state.errors[fingerprint] = entry;
    pruneStartupErrorTelemetryState(state);
    await writeStartupErrorTelemetryState(stateFile, state);

    return {
      capture,
      fingerprint,
      insertId,
      properties: startupErrorTelemetryProperties({
        fingerprint,
        throttleMs,
        captureCount: entry.captureCount,
        suppressedSinceLastCapture,
        totalSuppressed: entry.totalSuppressed
      })
    };
  } catch (throttleStateError) {
    return {
      capture: true,
      fingerprint,
      insertId,
      properties: {
        ...startupErrorTelemetryProperties({
          fingerprint,
          throttleMs,
          captureCount: 0,
          suppressedSinceLastCapture: 0,
          totalSuppressed: 0
        }),
        startup_error_throttle_failed: true
      },
      throttleStateError
    };
  }
}

function startupErrorTelemetryProperties(input: {
  fingerprint: string;
  throttleMs: number;
  captureCount: number;
  suppressedSinceLastCapture: number;
  totalSuppressed: number;
}): TelemetryProperties {
  return {
    startup_error_fingerprint: input.fingerprint,
    startup_error_throttle_ms: input.throttleMs,
    startup_error_capture_count: input.captureCount,
    startup_error_suppressed_since_last_capture: input.suppressedSinceLastCapture,
    startup_error_total_suppressed: input.totalSuppressed
  };
}

function startupErrorTelemetryInsertId(fingerprint: string, now: number, throttleMs: number): string {
  const bucket = Math.floor(now / throttleMs);
  return `runtime_start:${fingerprint}:${bucket}`;
}

function startupErrorFingerprint(error: unknown, context: StartupErrorTelemetryContext): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        errorType: context.errorType,
        errorSite: context.errorSite,
        operation: context.operation ?? null,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: errorCode(error),
        errorMessage: toErrorMessage(error),
        stack: error instanceof Error ? error.stack ?? null : null
      })
    )
    .digest("hex")
    .slice(0, 32);
}

async function readStartupErrorTelemetryState(stateFile: string): Promise<StartupErrorTelemetryState> {
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    return normalizeStartupErrorTelemetryState(JSON.parse(raw));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return createEmptyStartupErrorTelemetryState();
    }
    return createEmptyStartupErrorTelemetryState();
  }
}

async function writeStartupErrorTelemetryState(stateFile: string, state: StartupErrorTelemetryState): Promise<void> {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const tmpFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmpFile, stateFile);
}

function normalizeStartupErrorTelemetryState(value: unknown): StartupErrorTelemetryState {
  if (!value || typeof value !== "object") {
    return createEmptyStartupErrorTelemetryState();
  }
  const errors = (value as { errors?: unknown }).errors;
  if (!errors || typeof errors !== "object") {
    return createEmptyStartupErrorTelemetryState();
  }
  const normalized = createEmptyStartupErrorTelemetryState();
  for (const [fingerprint, entry] of Object.entries(errors)) {
    if (!/^[a-f0-9]{32}$/.test(fingerprint) || !entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Partial<StartupErrorTelemetryEntry>;
    const normalizedEntry = {
      firstSeenAt: normalizeNumber(candidate.firstSeenAt),
      lastSeenAt: normalizeNumber(candidate.lastSeenAt),
      lastCapturedAt: normalizeNumber(candidate.lastCapturedAt),
      captureCount: normalizeNumber(candidate.captureCount),
      suppressedSinceLastCapture: normalizeNumber(candidate.suppressedSinceLastCapture),
      totalSuppressed: normalizeNumber(candidate.totalSuppressed)
    };
    if (normalizedEntry.lastSeenAt <= 0) {
      continue;
    }
    normalized.errors[fingerprint] = normalizedEntry;
  }
  return normalized;
}

function pruneStartupErrorTelemetryState(state: StartupErrorTelemetryState): void {
  const entries = Object.entries(state.errors).sort(([, left], [, right]) => right.lastSeenAt - left.lastSeenAt);
  state.errors = Object.fromEntries(entries.slice(0, maxTrackedErrors));
}

function createEmptyStartupErrorTelemetryState(): StartupErrorTelemetryState {
  return {
    version: stateVersion,
    errors: {}
  };
}

function normalizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function errorCode(error: unknown): string | null {
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
