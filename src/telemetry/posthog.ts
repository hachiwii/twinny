import type { TelemetryProperties, TelemetryReporter } from "./reporter.js";

export interface PostHogTelemetryReporterOptions {
  apiKey: string;
  host: string;
  distinctId: string;
  fetch?: typeof fetch;
}

export class PostHogTelemetryReporter implements TelemetryReporter {
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PostHogTelemetryReporterOptions) {
    this.host = options.host.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async capture(event: string, properties: TelemetryProperties): Promise<void> {
    const response = await this.fetchImpl(`${this.host}/capture/`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        api_key: this.options.apiKey,
        event,
        distinct_id: this.options.distinctId,
        properties
      })
    });
    if (!response.ok) {
      throw new Error(`PostHog capture failed: ${response.status}`);
    }
  }
}
