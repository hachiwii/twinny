import { toErrorMessage } from "../errors.js";
import type { LarkLogger } from "../lark/index.js";

const DEFAULT_NOTIFICATION_TIMEOUT_MS = 5_000;

export interface SystemNotificationSender {
  sendTextToOpenId(openId: string, text: string, options?: { signal?: AbortSignal; uuid?: string }): Promise<unknown>;
}

export interface TwinnySystemNotifierOptions {
  ownerOpenId: string;
  sender: SystemNotificationSender;
  logger?: LarkLogger;
  timeoutMs?: number;
}

export class TwinnySystemNotifier {
  private readonly ownerOpenId: string;
  private readonly sender: SystemNotificationSender;
  private readonly logger?: LarkLogger;
  private readonly timeoutMs: number;

  constructor(options: TwinnySystemNotifierOptions) {
    this.ownerOpenId = options.ownerOpenId;
    this.sender = options.sender;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_NOTIFICATION_TIMEOUT_MS;
  }

  async notifyInitialized(options: { home: string; appId: string }): Promise<void> {
    await this.send(
      "initialized",
      [
        "Twinny 初始化完成",
        `home: ${options.home}`,
        `app_id: ${options.appId}`
      ].join("\n")
    );
  }

  async notifyGracefulExit(options: { signal: NodeJS.Signals }): Promise<void> {
    await this.send(
      "graceful_exit",
      [
        "Twinny 优雅退出",
        `signal: ${options.signal}`
      ].join("\n")
    );
  }

  private async send(kind: string, text: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await this.sender.sendTextToOpenId(this.ownerOpenId, text, { signal: controller.signal });
    } catch (error) {
      this.logger?.warn?.({ kind, error: toErrorMessage(error) }, "failed to send Twinny system notification");
    } finally {
      clearTimeout(timeout);
    }
  }
}
