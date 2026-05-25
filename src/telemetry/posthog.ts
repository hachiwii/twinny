import { PostHog } from "posthog-node";
import type { PostHogOptions } from "posthog-node";
import type { TelemetryProperties, TelemetryReporter } from "./reporter.js";

export interface PostHogTelemetryReporterOptions {
  apiKey: string;
  host: string;
  distinctId: string;
  fetch?: typeof fetch;
  client?: PostHogTelemetryClient;
}

export interface PostHogTelemetryClient {
  capture(message: { distinctId: string; event: string; properties: TelemetryProperties }): void;
  captureException(error: unknown, distinctId?: string, additionalProperties?: Record<string | number, unknown>): void;
  flush(): Promise<void>;
  _shutdown?(shutdownTimeoutMs?: number): Promise<void>;
}

export class PostHogTelemetryReporter implements TelemetryReporter {
  private readonly client: PostHogTelemetryClient;

  constructor(private readonly options: PostHogTelemetryReporterOptions) {
    this.client = options.client ?? createPostHogClient(options);
  }

  capture(event: string, properties: TelemetryProperties): void {
    this.client.capture({
      distinctId: this.options.distinctId,
      event,
      properties
    });
  }

  captureException(error: unknown, properties: TelemetryProperties): void {
    this.client.captureException(error, this.options.distinctId, properties);
  }

  async flush(): Promise<void> {
    await this.client.flush();
  }

  async shutdown(): Promise<void> {
    if (this.client._shutdown) {
      await this.client._shutdown(5_000);
      return;
    }
    await this.client.flush();
  }
}

function createPostHogClient(options: PostHogTelemetryReporterOptions): PostHogTelemetryClient {
  const posthogOptions: PostHogOptions = {
    host: options.host.replace(/\/+$/, ""),
    enableExceptionAutocapture: true,
    flushAt: 1,
    flushInterval: 5_000,
    preloadFeatureFlags: false,
    disableRemoteConfig: true,
    disableSurveys: true
  };
  if (options.fetch) {
    posthogOptions.fetch = options.fetch as PostHogOptions["fetch"];
  }
  return new PostHog(options.apiKey, posthogOptions);
}
