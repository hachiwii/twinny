import { describe, expect, it, vi } from "vitest";
import {
  buildLarkEventConfigUrl,
  buildLarkScopeApplyUrl,
  evaluateLarkFeatureSet,
  formatLarkFeatureCheckIssueText,
  LARK_FEATURE_SET_DEFINITIONS,
  LarkFeatureConfigurationChecker,
  parseCurrentPublishedLarkAppVersion
} from "./feature-config.js";

describe("Lark feature configuration checks", () => {
  it("parses the current published app version scopes and event subscriptions", () => {
    const snapshot = parseCurrentPublishedLarkAppVersion({
      data: {
        items: [
          {
            version_id: "draft",
            status: 4,
            publish_time: null,
            event_infos: [{ event_type: "draft.event" }],
            scopes: [{ scope: "draft:scope", token_types: ["tenant"] }]
          },
          {
            version_id: "published",
            version: "1.2.3",
            status: 1,
            publish_time: "2026-05-28 12:00:00",
            event_infos: [
              { event_type: "im.message.receive_v1" },
              { event_type: "im.message.recalled_v1" }
            ],
            scopes: [
              { scope: "im:message.p2p_msg:readonly", token_types: ["tenant"] },
              { scope: "contact:user.base", token_types: ["user"] },
              { scope: "im:message:send_as_bot" }
            ]
          }
        ]
      }
    });

    expect(snapshot).toMatchObject({
      version: "1.2.3",
      versionId: "published",
      hasPublishedVersion: true
    });
    expect(snapshot.scopes.has("im:message.p2p_msg:readonly")).toBe(true);
    expect(snapshot.scopes.has("im:message:send_as_bot")).toBe(true);
    expect(snapshot.scopes.has("contact:user.base")).toBe(false);
    expect(snapshot.subscriptions.get("im.message.receive_v1")).toEqual({ eventType: "im.message.receive_v1" });
    expect(snapshot.subscriptions.get("im.message.recalled_v1")).toEqual({ eventType: "im.message.recalled_v1" });
  });

  it("evaluates necessary scopes and observable events", () => {
    const snapshot = parseCurrentPublishedLarkAppVersion({
      data: {
        items: [
          {
            version_id: "published",
            version: "1.0.0",
            status: 1,
            publish_time: "2026-05-28",
            event_infos: [
              { event_type: "im.message.receive_v1" },
              { event_type: "im.message.recalled_v1" }
            ],
            scopes: LARK_FEATURE_SET_DEFINITIONS.necessary.scopes
              .filter((scope) => scope !== "im:resource")
              .map((scope) => ({ scope, token_types: ["tenant"] }))
          }
        ]
      }
    });

    const result = evaluateLarkFeatureSet(LARK_FEATURE_SET_DEFINITIONS.necessary, snapshot, "cli_app");

    expect(result.ok).toBe(false);
    expect(result.missingScopes).toEqual(["im:resource"]);
    expect(result.missingCallbacks).toEqual([]);
    expect(result.nonLongConnectionEvents).toEqual([]);
    expect(result.nonLongConnectionCallbacks).toEqual([]);
    expect(result.scopeApplyUrl).toBe("https://open.larkoffice.com/page/scope-apply?clientID=cli_app&scopes=im%3Aresource");
    expect(result.eventConfigUrl).toBeUndefined();
  });

  it("accepts the real app version event shape without long-connection metadata", () => {
    const snapshot = parseCurrentPublishedLarkAppVersion({
      data: {
        items: [
          {
            version_id: "published",
            version: "1.0.0",
            status: 1,
            publish_time: "2026-05-28",
            event_infos: [
              {
                event_description: "用户发送新消息至机器人或群聊后推送事件",
                event_name: "接收消息",
                event_type: "im.message.receive_v1"
              },
              {
                event_description: "某条消息被撤回",
                event_name: "消息撤回",
                event_type: "im.message.recalled_v1"
              }
            ],
            scopes: LARK_FEATURE_SET_DEFINITIONS.necessary.scopes.map((scope) => ({ scope, token_types: ["tenant"] }))
          }
        ]
      }
    });

    const result = evaluateLarkFeatureSet(LARK_FEATURE_SET_DEFINITIONS.necessary, snapshot, "cli_app");

    expect(result).toMatchObject({
      ok: true,
      missingEvents: [],
      missingCallbacks: [],
      nonLongConnectionEvents: [],
      nonLongConnectionCallbacks: []
    });
    expect(result.eventConfigUrl).toBeUndefined();
  });

  it("evaluates auto activation scope and event subscriptions", () => {
    const snapshot = parseCurrentPublishedLarkAppVersion(appVersionResponse({
      scopes: LARK_FEATURE_SET_DEFINITIONS.auto_activation.scopes,
      events: ["p2p_chat_create"]
    }));
    const result = evaluateLarkFeatureSet(LARK_FEATURE_SET_DEFINITIONS.auto_activation, snapshot, "cli_app");

    expect(result.ok).toBe(false);
    expect(result.missingScopes).toEqual([]);
    expect(result.missingEvents).toEqual(["im.chat.member.bot.added_v1"]);
    expect(result.eventConfigUrl).toBe("https://open.larkoffice.com/app/cli_app/event?tab=event");
  });

  it("evaluates only requested auto activation events for dynamic startup checks", () => {
    const snapshot = parseCurrentPublishedLarkAppVersion(appVersionResponse({
      scopes: LARK_FEATURE_SET_DEFINITIONS.auto_activation.scopes,
      events: ["p2p_chat_create"]
    }));
    const result = evaluateLarkFeatureSet(
      {
        ...LARK_FEATURE_SET_DEFINITIONS.auto_activation,
        events: ["p2p_chat_create"]
      },
      snapshot,
      "cli_app"
    );

    expect(result.ok).toBe(true);
    expect(result.missingScopes).toEqual([]);
    expect(result.missingEvents).toEqual([]);
    expect(result.eventConfigUrl).toBeUndefined();
  });

  it("builds event configuration links for event and callback combinations", () => {
    expect(buildLarkEventConfigUrl("cli_app", { hasEventIssues: true, hasCallbackIssues: false })).toBe(
      "https://open.larkoffice.com/app/cli_app/event?tab=event"
    );
    expect(buildLarkEventConfigUrl("cli_app", { hasEventIssues: false, hasCallbackIssues: true })).toBe(
      "https://open.larkoffice.com/app/cli_app/event?tab=callback"
    );
    expect(buildLarkEventConfigUrl("cli_app", { hasEventIssues: true, hasCallbackIssues: true })).toBe(
      "https://open.larkoffice.com/app/cli_app/event"
    );
  });

  it("builds one scope quick-apply link for all missing scopes", () => {
    expect(buildLarkScopeApplyUrl("cli_app", ["docs:document.comment:read", "docs:document.media:download"])).toBe(
      "https://open.larkoffice.com/page/scope-apply?clientID=cli_app&scopes=docs%3Adocument.comment%3Aread%2Cdocs%3Adocument.media%3Adownload"
    );
  });

  it("caches satisfied feature sets but keeps unmet feature sets recheckable", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(appVersionResponse({ scopes: LARK_FEATURE_SET_DEFINITIONS.group_non_at.scopes }))
      .mockResolvedValueOnce(appVersionResponse({ scopes: [] }));
    const checker = new LarkFeatureConfigurationChecker({
      appId: "cli_app",
      openApiClient: { request }
    });

    await expect(checker.checkFeatureSet("group_non_at")).resolves.toMatchObject({ ok: true });
    await expect(checker.checkFeatureSet("group_non_at")).resolves.toMatchObject({ ok: true });
    await expect(checker.checkFeatureSet("doc_watch")).resolves.toMatchObject({ ok: false });
    await expect(checker.checkFeatureSet("doc_watch")).resolves.toMatchObject({ ok: false });

    expect(request).toHaveBeenCalledTimes(3);
  });

  it("skips all checks after app configuration cannot be queried", async () => {
    const request = vi.fn(async () => {
      throw new Error("missing app version permission");
    });
    const checker = new LarkFeatureConfigurationChecker({
      appId: "cli_app",
      openApiClient: { request }
    });

    await expect(checker.checkFeatureSet("necessary")).resolves.toMatchObject({
      ok: true,
      skipped: true,
      skipReason: "missing app version permission"
    });
    await expect(checker.checkFeatureSet("doc_watch")).resolves.toMatchObject({
      ok: true,
      skipped: true,
      skipReason: "missing app version permission"
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uses a specific warning when only document media download is missing", () => {
    const snapshot = parseCurrentPublishedLarkAppVersion(appVersionResponse({
      scopes: LARK_FEATURE_SET_DEFINITIONS.doc_watch.scopes.filter((scope) => scope !== "docs:document.media:download"),
      events: LARK_FEATURE_SET_DEFINITIONS.doc_watch.events
    }));
    const result = evaluateLarkFeatureSet(LARK_FEATURE_SET_DEFINITIONS.doc_watch, snapshot, "cli_app");

    expect(formatLarkFeatureCheckIssueText(result, { usage: "doc_watch" })).toContain(
      "bot 无法看到文档中的图片"
    );
  });
});

function appVersionResponse(options: { scopes: readonly string[]; events?: readonly string[] }) {
  return {
    data: {
      items: [
        {
          version_id: "published",
          version: "1.0.0",
          status: 1,
          publish_time: "2026-05-28",
          event_infos: (options.events ?? ["im.message.receive_v1"]).map((event) => ({
            event_type: event,
            receive_mode: "long_connection"
          })),
          scopes: options.scopes.map((scope) => ({ scope, token_types: ["tenant"] }))
        }
      ]
    }
  };
}
