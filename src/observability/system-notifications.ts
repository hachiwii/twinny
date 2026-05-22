import { toErrorMessage } from "../errors.js";
import { renderTwinnyBannerCard, type LarkCardJson } from "../lark/cards.js";
import { TWINNY_VERSION } from "../version.js";
import type { LarkLogger } from "../lark/index.js";

const DEFAULT_NOTIFICATION_TIMEOUT_MS = 5_000;

export interface SystemNotificationSender {
  sendInteractiveCardToOpenId(openId: string, card: LarkCardJson, options?: { signal?: AbortSignal; uuid?: string }): Promise<unknown>;
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

  async notifyInitialized(options: { bannerImageKey?: string } = {}): Promise<void> {
    await this.sendCard(
      "initialized",
      renderTwinnyBannerCard({ bannerImageKey: options.bannerImageKey, twinnyVersion: TWINNY_VERSION })
    );
  }

  private async sendCard(kind: string, card: LarkCardJson): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await this.sender.sendInteractiveCardToOpenId(this.ownerOpenId, card, { signal: controller.signal });
    } catch (error) {
      this.logger?.warn?.({ kind, error: toErrorMessage(error) }, "failed to send Twinny system notification");
    } finally {
      clearTimeout(timeout);
    }
  }
}
