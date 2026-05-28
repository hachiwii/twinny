import { describe, expect, it, vi } from "vitest";
import { TwinnySystemNotifier, type SystemNotificationSender } from "./system-notifications.js";

describe("TwinnySystemNotifier", () => {
  it("sends the startup banner card to the owner", async () => {
    const sender = createSender();
    const notifier = new TwinnySystemNotifier({
      ownerOpenId: "ou_owner",
      sender
    });

    await notifier.notifyInitialized({ bannerImageKey: "img_banner" });

    expect(sender.sendInteractiveCardToOpenId).toHaveBeenCalledWith(
      "ou_owner",
      expect.objectContaining({ schema: "2.0" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(JSON.stringify(sender.sendInteractiveCardToOpenId.mock.calls[0]![1])).toContain("img_banner");
    expect(JSON.stringify(sender.sendInteractiveCardToOpenId.mock.calls[0]![1])).toContain(
      "Twinny - Command Codex in Feishu"
    );
    expect(JSON.stringify(sender.sendInteractiveCardToOpenId.mock.calls[0]![1])).toContain("dev |");
    expect(
      (sender.sendInteractiveCardToOpenId.mock.calls[0]![1].config as { summary?: { content?: string } }).summary
        ?.content
    ).toBe("🐰 Twinny dev");
    expect(sender.sendInteractiveCardToOpenId).toHaveBeenCalledTimes(1);
  });

  it("logs notification failures without throwing", async () => {
    const logger = { warn: vi.fn() };
    const sender = {
      sendInteractiveCardToOpenId: vi.fn(async () => {
        throw new Error("send failed");
      })
    } satisfies SystemNotificationSender;
    const notifier = new TwinnySystemNotifier({
      ownerOpenId: "ou_owner",
      sender,
      logger
    });

    await expect(notifier.notifyInitialized()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "initialized", error: "send failed" }),
      "failed to send Twinny system notification"
    );
  });

  it("sends missing Lark configuration cards to the owner", async () => {
    const sender = createSender();
    const notifier = new TwinnySystemNotifier({
      ownerOpenId: "ou_owner",
      sender
    });

    await notifier.notifyMissingLarkConfiguration([
      {
        key: "necessary",
        label: "必要配置",
        ok: false,
        skipped: false,
        missingScopes: ["im:resource"],
        missingEvents: ["im.message.receive_v1"],
        missingCallbacks: ["card.action.trigger"],
        nonLongConnectionEvents: [],
        nonLongConnectionCallbacks: [],
        scopeApplyUrl: "https://open.larkoffice.com/page/scope-apply?clientID=cli_app&scopes=im%3Aresource",
        eventConfigUrl: "https://open.larkoffice.com/app/cli_app/event",
        hasPublishedVersion: true
      }
    ]);

    expect(sender.sendInteractiveCardToOpenId).toHaveBeenCalledWith(
      "ou_owner",
      expect.objectContaining({ schema: "2.0" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const card = JSON.stringify(sender.sendInteractiveCardToOpenId.mock.calls[0]![1]);
    expect(card).toContain("Twinny Lark 配置未完成");
    expect(card).toContain("im:resource");
    expect(card).toContain("card.action.trigger");
  });
});

function createSender(): SystemNotificationSender & { sendInteractiveCardToOpenId: ReturnType<typeof vi.fn> } {
  return {
    sendInteractiveCardToOpenId: vi.fn(async () => ({ messageId: "om_1" }))
  };
}
