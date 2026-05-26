import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordStartupErrorTelemetryAttempt } from "./startup-error-telemetry.js";

describe("startup error telemetry throttling", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("captures the first startup error and suppresses repeats inside the throttle window", async () => {
    const paths = createPaths();
    const error = createStartupError("Lark app secret is missing");
    let now = 1_000;

    const first = await recordStartupErrorTelemetryAttempt(paths, error, startupContext(), {
      now: () => now,
      throttleMs: 60_000
    });

    expect(first.capture).toBe(true);
    expect(first.properties).toMatchObject({
      startup_error_capture_count: 1,
      startup_error_suppressed_since_last_capture: 0,
      startup_error_total_suppressed: 0,
      startup_error_throttle_ms: 60_000
    });

    now += 1_000;
    const second = await recordStartupErrorTelemetryAttempt(paths, error, startupContext(), {
      now: () => now,
      throttleMs: 60_000
    });

    expect(second.capture).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);

    now += 60_000;
    const third = await recordStartupErrorTelemetryAttempt(paths, error, startupContext(), {
      now: () => now,
      throttleMs: 60_000
    });

    expect(third.capture).toBe(true);
    expect(third.fingerprint).toBe(first.fingerprint);
    expect(third.properties).toMatchObject({
      startup_error_capture_count: 2,
      startup_error_suppressed_since_last_capture: 1,
      startup_error_total_suppressed: 1
    });
  });

  it("tracks distinct startup errors independently", async () => {
    const paths = createPaths();
    const options = { now: () => 1_000, throttleMs: 60_000 };

    const first = await recordStartupErrorTelemetryAttempt(paths, createStartupError("missing secret"), startupContext(), options);
    const second = await recordStartupErrorTelemetryAttempt(paths, createStartupError("codex missing"), startupContext(), options);

    expect(first.capture).toBe(true);
    expect(second.capture).toBe(true);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it("falls back to capturing when throttle state cannot be written", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-startup-telemetry-"));
    tempDirs.push(home);
    const runtimeDir = path.join(home, "runtime");
    fs.writeFileSync(runtimeDir, "not a directory");

    const decision = await recordStartupErrorTelemetryAttempt(
      { runtimeDir },
      createStartupError("missing secret"),
      startupContext(),
      { now: () => 1_000, throttleMs: 60_000 }
    );

    expect(decision.capture).toBe(true);
    expect(decision.throttleStateError).toBeDefined();
    expect(decision.properties).toMatchObject({
      startup_error_throttle_failed: true
    });
  });

  function createPaths(): { runtimeDir: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-startup-telemetry-"));
    tempDirs.push(home);
    return { runtimeDir: path.join(home, "runtime") };
  }

  function startupContext() {
    return {
      errorType: "runtime_start",
      errorSite: "runtime.start",
      operation: "start"
    };
  }

  function createStartupError(message: string): Error {
    const error = new Error(message);
    error.stack = `Error: ${message}\n    at TwinnyRuntime.start (wiring.ts:100:1)`;
    return error;
  }
});
