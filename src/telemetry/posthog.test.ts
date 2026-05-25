import { describe, expect, it, vi } from "vitest";
import { PostHogTelemetryReporter, type PostHogTelemetryClient } from "./posthog.js";

describe("PostHogTelemetryReporter", () => {
  it("captures analytics events through the PostHog SDK", () => {
    const client = createPostHogClient();
    const reporter = new PostHogTelemetryReporter({
      apiKey: "ph_test",
      host: "https://posthog.example",
      distinctId: "install_hash",
      client
    });

    reporter.capture("twinny_launch", { runtime_id: "runtime_1" });

    expect(client.capture).toHaveBeenCalledWith({
      distinctId: "install_hash",
      event: "twinny_launch",
      properties: { runtime_id: "runtime_1" }
    });
  });

  it("captures exceptions through the PostHog SDK", () => {
    const client = createPostHogClient();
    const reporter = new PostHogTelemetryReporter({
      apiKey: "ph_test",
      host: "https://posthog.example",
      distinctId: "install_hash",
      client
    });
    const error = new Error("sanitized");

    reporter.captureException(error, { error_type: "runtime" });

    expect(client.captureException).toHaveBeenCalledWith(error, "install_hash", { error_type: "runtime" });
  });

  it("uses SDK shutdown so pending exception promises are drained", async () => {
    const client = createPostHogClient();
    const reporter = new PostHogTelemetryReporter({
      apiKey: "ph_test",
      host: "https://posthog.example",
      distinctId: "install_hash",
      client
    });

    await reporter.shutdown();

    expect(client._shutdown).toHaveBeenCalledWith(5_000);
    expect(client.flush).not.toHaveBeenCalled();
  });
});

function createPostHogClient(): PostHogTelemetryClient {
  return {
    capture: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn(),
    _shutdown: vi.fn()
  };
}
