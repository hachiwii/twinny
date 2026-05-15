import fs from "node:fs";
import path from "node:path";
import pino, { type Logger } from "pino";

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

export const logger = createLogger();
