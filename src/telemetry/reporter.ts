import type { Logger } from "pino";

export type TelemetryProperties = Record<string, unknown>;

export interface TelemetryReporter {
  capture(event: string, properties: TelemetryProperties): Promise<void> | void;
  flush?(): Promise<void> | void;
}

export class NullTelemetryReporter implements TelemetryReporter {
  capture(): void {
    return;
  }
}

export function captureTelemetryBestEffort(
  reporter: TelemetryReporter,
  event: string,
  properties: TelemetryProperties,
  logger?: Pick<Logger, "warn">
): void {
  try {
    void Promise.resolve(reporter.capture(event, properties)).catch((error: unknown) => {
      logger?.warn({ error, event }, "failed to capture telemetry event");
    });
  } catch (error) {
    logger?.warn({ error, event }, "failed to capture telemetry event");
  }
}
