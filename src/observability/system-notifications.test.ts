import { describe, expect, it, vi } from "vitest";
import { TwinnySystemNotifier, type SystemNotificationSender } from "./system-notifications.js";

describe("TwinnySystemNotifier", () => {
  it("sends initialization and graceful exit notifications to the owner", async () => {
    const sender = createSender();
    const notifier = new TwinnySystemNotifier({
      ownerOpenId: "ou_owner",
      sender
    });

    await notifier.notifyInitialized({ home: "/tmp/twinny", appId: "cli_app" });
    await notifier.notifyGracefulExit({ signal: "SIGTERM" });

    expect(sender.sendTextToOpenId).toHaveBeenNthCalledWith(
      1,
      "ou_owner",
      ["Twinny 初始化完成", "home: /tmp/twinny", "app_id: cli_app"].join("\n"),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(sender.sendTextToOpenId).toHaveBeenNthCalledWith(
      2,
      "ou_owner",
      ["Twinny 优雅退出", "signal: SIGTERM"].join("\n"),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(sender.sendTextToOpenId).toHaveBeenCalledTimes(2);
  });

  it("logs notification failures without throwing", async () => {
    const logger = { warn: vi.fn() };
    const sender = {
      sendTextToOpenId: vi.fn(async () => {
        throw new Error("send failed");
      })
    } satisfies SystemNotificationSender;
    const notifier = new TwinnySystemNotifier({
      ownerOpenId: "ou_owner",
      sender,
      logger
    });

    await expect(notifier.notifyInitialized({ home: "/tmp/twinny", appId: "cli_app" })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "initialized", error: "send failed" }),
      "failed to send Twinny system notification"
    );
  });
});

function createSender(): SystemNotificationSender & { sendTextToOpenId: ReturnType<typeof vi.fn> } {
  return {
    sendTextToOpenId: vi.fn(async () => ({ messageId: "om_1" }))
  };
}
