import { describe, expect, it, vi } from "vitest";
import type { TwinnyConfig } from "../types.js";
import { TwinnyTelemetryClient } from "./client.js";
import type { TelemetryReporter } from "./reporter.js";

const config: TwinnyConfig = {
  home: "/tmp/twinny",
  codex: { binary: "codex" },
  lark: {
    workingReaction: "Typing",
    completedReaction: "DONE",
    queuedReaction: "OneSecond",
    maxMessageAgeSeconds: 60,
    messageRedaction: { email: "mask", chinesePhoneNumber: "mask" }
  },
  auth: { larkAppId: "cli_xxx", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner" },
  homeIdentity: {
    random: "0123456789abcdef0123456789abcdef",
    telemetryHashSalt: "0123456789abcdef0123456789abcdef",
    keychainAccounts: {
      larkAppSecret: "twinny.home.0123456789abcdef0123456789abcdef.lark.app_secret"
    }
  },
  permissions: { p2pDefaultProfile: "guest" },
  telemetry: { enabled: true, posthogProjectToken: "ph_test", posthogHost: "https://posthog.example" },
  owner: { openId: "ou_owner", displayName: "Owner" },
  profiles: {
    host: { codexHome: "/tmp/twinny/profiles/host/codex" },
    guest: { codexHome: "/tmp/twinny/profiles/guest/codex" }
  }
};

describe("TwinnyTelemetryClient", () => {
  it("adds common properties and one codex version", () => {
    const reporter = createReporter();
    const client = new TwinnyTelemetryClient(config, {
      reporter,
      runtimeId: "runtime_1",
      now: () => 123,
      osVersion: "14.7",
      timezoneOffsetMinutes: () => 480,
      codexVersion: () => "codex 1.2.3"
    });

    client.capture("twinny_launch", { launch_duration_ms: 42 }, { insertId: "launch_1" });

    expect(reporter.capture).toHaveBeenCalledWith("twinny_launch", expect.objectContaining({
      schema_version: 1,
      install_id: expect.any(String),
      runtime_id: "runtime_1",
      event_ts_ms: 123,
      twinny_version: expect.any(String),
      codex_version: "codex 1.2.3",
      os_platform: expect.any(String),
      os_arch: expect.any(String),
      os_version: "14.7",
      timezone_offset: "+08:00",
      timezone_offset_minutes: 480,
      node_version: process.versions.node,
      lark_brand: "feishu",
      profile_count: 2,
      launch_duration_ms: 42,
      $insert_id: "launch_1"
    }));
  });

  it("hashes error details without sending raw error messages", () => {
    const reporter = createReporter();
    const client = new TwinnyTelemetryClient(config, {
      reporter,
      runtimeId: "runtime_1",
      now: () => 123,
      osVersion: "14.7",
      timezoneOffsetMinutes: () => 330
    });

    client.captureError(new Error("contains ou_secret"), {
      errorType: "conversation",
      errorSite: "conversation.test",
      conversationKey: "p2p_ou_secret"
    });

    const payload = vi.mocked(reporter.capture).mock.calls[0]![1];
    expect(payload.error_message_hash).toEqual(expect.any(String));
    expect(payload.error_message_redacted).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("ou_secret");

    const [exception, exceptionPayload] = vi.mocked(reporter.captureException!).mock.calls[0]!;
    expect(exception).toBeInstanceOf(Error);
    expect((exception as Error).message).toBe("conversation:conversation.test");
    expect(exceptionPayload.telemetry_error_event).toBe("twinny_error");
    expect(exceptionPayload.timezone_offset).toBe("+05:30");
    expect(exceptionPayload.timezone_offset_minutes).toBe(330);
    expect(exceptionPayload.error_message_hash).toEqual(expect.any(String));
    expect(JSON.stringify(exceptionPayload)).not.toContain("ou_secret");
  });

  it("drains telemetry reporters on shutdown", async () => {
    const reporter = createReporter();
    const client = new TwinnyTelemetryClient(config, { reporter });

    await client.shutdown();

    expect(reporter.shutdown).toHaveBeenCalled();
    expect(reporter.flush).not.toHaveBeenCalled();
  });
});

function createReporter(): TelemetryReporter {
  return {
    capture: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn(),
    shutdown: vi.fn()
  };
}
