import fs from "node:fs";
import path from "node:path";
import pino, { type Logger } from "pino";
import type { LarkSdkLogger } from "../lark/types.js";

export interface LoggerOptions {
  level?: string;
  logFile?: string;
  pretty?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? process.env.TWINNY_LOG_LEVEL ?? "info";
  if (options.logFile) {
    fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
    return pino({ level }, pino.destination({ dest: options.logFile, sync: false }));
  }
  if (options.pretty ?? process.stdout.isTTY) {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" }
      }
    });
  }
  return pino({ level });
}

export function createLarkSdkLogger(logger: Pick<Logger, "trace" | "debug" | "info" | "warn" | "error">): LarkSdkLogger {
  return {
    trace: (...args) => logger.trace({ args: normalizeExternalLoggerArgs(args) }, "lark sdk trace"),
    debug: (...args) => logger.debug({ args: normalizeExternalLoggerArgs(args) }, "lark sdk debug"),
    info: (...args) => logger.info({ args: normalizeExternalLoggerArgs(args) }, "lark sdk info"),
    warn: (...args) => logger.warn({ args: normalizeExternalLoggerArgs(args) }, "lark sdk warn"),
    error: (...args) => logger.error({ args: normalizeExternalLoggerArgs(args) }, "lark sdk error")
  };
}

function normalizeExternalLoggerArgs(args: unknown[]): unknown {
  return args.length === 1 ? args[0] : args;
}

export const logger = createLogger();
