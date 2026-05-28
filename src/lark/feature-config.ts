import { toErrorMessage } from "../errors.js";
import {
  LARK_BOT_MENU_EVENT,
  LARK_DOC_COMMENT_ADD_EVENT,
  LARK_GROUP_ALL_MESSAGES_SCOPE,
  LARK_GROUP_MENTION_SCOPE,
  LARK_MESSAGE_RECEIVE_EVENT,
  LARK_MESSAGE_RECALLED_EVENT,
  LARK_REQUIRED_SCOPE_ALTERNATIVES,
  type LarkLogger
} from "./types.js";

export type LarkFeatureSetKey = "necessary" | "group_non_at" | "doc_watch" | "bot_menu";

export interface LarkFeatureSetDefinition {
  key: LarkFeatureSetKey;
  label: string;
  scopes: readonly string[];
  events: readonly string[];
}

export interface LarkFeatureCheckResult {
  key: LarkFeatureSetKey;
  label: string;
  ok: boolean;
  skipped: boolean;
  skipReason?: string;
  missingScopes: string[];
  missingEvents: string[];
  missingCallbacks: string[];
  nonLongConnectionEvents: string[];
  nonLongConnectionCallbacks: string[];
  scopeApplyUrl?: string;
  eventConfigUrl?: string;
  publishedVersion?: string;
  publishedVersionId?: string;
  hasPublishedVersion: boolean;
}

export interface LarkAppVersionSnapshot {
  version?: string;
  versionId?: string;
  hasPublishedVersion: boolean;
  scopes: Set<string>;
  subscriptions: Map<string, LarkEventSubscriptionState>;
}

export interface LarkEventSubscriptionState {
  eventType: string;
}

export interface LarkFeatureConfigurationCheckerOptions {
  appId: string;
  openApiClient: Pick<{ request(pathname: string, options?: { method?: "GET"; query?: Record<string, string | number | boolean | undefined> }): Promise<unknown> }, "request">;
  logger?: LarkLogger;
}

const LARK_OPEN_CONSOLE_BASE_URL = "https://open.larkoffice.com";

export const LARK_NECESSARY_FEATURE_SCOPES = [
  "im:message.p2p_msg:readonly",
  LARK_GROUP_MENTION_SCOPE,
  "im:message:readonly",
  "im:message:send_as_bot",
  "im:message:update",
  "im:message:recall",
  "im:message.reactions:write_only",
  "im:chat:read",
  "im:resource"
] as const;

export const LARK_GROUP_NON_AT_FEATURE_SCOPES = [
  LARK_GROUP_ALL_MESSAGES_SCOPE
] as const;

export const LARK_DOC_WATCH_FEATURE_SCOPES = [
  "docs:document.comment:read",
  "docs:document.comment:create",
  "docs:document.comment:write_only",
  "docs:document.media:download",
  "wiki:node:read"
] as const;

export const LARK_FEATURE_SET_DEFINITIONS: Readonly<Record<LarkFeatureSetKey, LarkFeatureSetDefinition>> = {
  necessary: {
    key: "necessary",
    label: "必要配置",
    scopes: LARK_NECESSARY_FEATURE_SCOPES,
    events: [LARK_MESSAGE_RECEIVE_EVENT, LARK_MESSAGE_RECALLED_EVENT]
  },
  group_non_at: {
    key: "group_non_at",
    label: "群聊非 at 消息",
    scopes: LARK_GROUP_NON_AT_FEATURE_SCOPES,
    events: [LARK_MESSAGE_RECEIVE_EVENT]
  },
  doc_watch: {
    key: "doc_watch",
    label: "文档监听",
    scopes: LARK_DOC_WATCH_FEATURE_SCOPES,
    events: [LARK_DOC_COMMENT_ADD_EVENT]
  },
  bot_menu: {
    key: "bot_menu",
    label: "Bot 菜单",
    scopes: [],
    events: [LARK_BOT_MENU_EVENT]
  }
};

const LARK_FEATURE_SET_KEYS = Object.keys(LARK_FEATURE_SET_DEFINITIONS) as LarkFeatureSetKey[];

const LARK_FEATURE_SCOPE_ALTERNATIVES: Readonly<Record<string, readonly string[]>> = {
  ...LARK_REQUIRED_SCOPE_ALTERNATIVES,
  [LARK_GROUP_ALL_MESSAGES_SCOPE]: ["im:message.group_msg:readonly"]
};

export class LarkFeatureConfigurationChecker {
  private readonly appId: string;
  private readonly openApiClient: LarkFeatureConfigurationCheckerOptions["openApiClient"];
  private readonly logger?: LarkLogger;
  private readonly satisfied = new Set<LarkFeatureSetKey>();
  private skipReason?: string;

  constructor(options: LarkFeatureConfigurationCheckerOptions) {
    this.appId = options.appId;
    this.openApiClient = options.openApiClient;
    this.logger = options.logger;
  }

  async checkAllFeatureSets(keys: readonly LarkFeatureSetKey[] = LARK_FEATURE_SET_KEYS): Promise<LarkFeatureCheckResult[]> {
    const remaining = keys.filter((key) => !this.satisfied.has(key));
    if (remaining.length === 0) {
      return keys.map((key) => this.satisfiedResult(key));
    }

    const snapshot = await this.fetchSnapshot();
    if (!snapshot) {
      return keys.map((key) => this.skippedResult(key));
    }

    const evaluated = new Map<LarkFeatureSetKey, LarkFeatureCheckResult>();
    for (const key of remaining) {
      const result = evaluateLarkFeatureSet(
        LARK_FEATURE_SET_DEFINITIONS[key],
        snapshot,
        this.appId
      );
      if (result.ok) {
        this.satisfied.add(key);
      }
      evaluated.set(key, result);
    }

    return keys.map((key) => this.satisfied.has(key) && !evaluated.has(key)
      ? this.satisfiedResult(key)
      : evaluated.get(key) ?? this.satisfiedResult(key)
    );
  }

  async checkFeatureSet(key: LarkFeatureSetKey): Promise<LarkFeatureCheckResult> {
    if (this.satisfied.has(key)) {
      return this.satisfiedResult(key);
    }
    const snapshot = await this.fetchSnapshot();
    if (!snapshot) {
      return this.skippedResult(key);
    }
    const result = evaluateLarkFeatureSet(LARK_FEATURE_SET_DEFINITIONS[key], snapshot, this.appId);
    if (result.ok) {
      this.satisfied.add(key);
    }
    return result;
  }

  private async fetchSnapshot(): Promise<LarkAppVersionSnapshot | undefined> {
    if (this.skipReason) {
      return undefined;
    }
    try {
      return parseCurrentPublishedLarkAppVersion(
        await this.openApiClient.request(`/application/v6/applications/${encodeURIComponent(this.appId)}/app_versions`, {
          method: "GET",
          query: {
            lang: "zh_cn",
            page_size: 2
          }
        })
      );
    } catch (error) {
      this.skipReason = toErrorMessage(error);
      this.logger?.warn?.({ error: this.skipReason }, "skipping Lark feature configuration checks");
      return undefined;
    }
  }

  private satisfiedResult(key: LarkFeatureSetKey): LarkFeatureCheckResult {
    const definition = LARK_FEATURE_SET_DEFINITIONS[key];
    return {
      key,
      label: definition.label,
      ok: true,
      skipped: false,
      missingScopes: [],
      missingEvents: [],
      missingCallbacks: [],
      nonLongConnectionEvents: [],
      nonLongConnectionCallbacks: [],
      hasPublishedVersion: true
    };
  }

  private skippedResult(key: LarkFeatureSetKey): LarkFeatureCheckResult {
    const definition = LARK_FEATURE_SET_DEFINITIONS[key];
    return {
      key,
      label: definition.label,
      ok: true,
      skipped: true,
      skipReason: this.skipReason ?? "unable to query Lark app configuration",
      missingScopes: [],
      missingEvents: [],
      missingCallbacks: [],
      nonLongConnectionEvents: [],
      nonLongConnectionCallbacks: [],
      hasPublishedVersion: false
    };
  }
}

export function evaluateLarkFeatureSet(
  definition: LarkFeatureSetDefinition,
  snapshot: LarkAppVersionSnapshot,
  appId: string
): LarkFeatureCheckResult {
  const missingScopes = definition.scopes.filter((scope) => !hasLarkScope(scope, snapshot.scopes));
  const missingEvents: string[] = [];
  const missingCallbacks: string[] = [];
  const nonLongConnectionEvents: string[] = [];
  const nonLongConnectionCallbacks: string[] = [];

  for (const event of definition.events) {
    const subscription = snapshot.subscriptions.get(event);
    if (!subscription) {
      missingEvents.push(event);
      continue;
    }
  }

  const eventConfigUrl = buildLarkEventConfigUrl(appId, {
    hasEventIssues: missingEvents.length > 0,
    hasCallbackIssues: false
  });
  const ok =
    snapshot.hasPublishedVersion &&
    missingScopes.length === 0 &&
    missingEvents.length === 0;

  return {
    key: definition.key,
    label: definition.label,
    ok,
    skipped: false,
    missingScopes: snapshot.hasPublishedVersion ? missingScopes : [...definition.scopes],
    missingEvents: snapshot.hasPublishedVersion ? missingEvents : [...definition.events],
    missingCallbacks,
    nonLongConnectionEvents,
    nonLongConnectionCallbacks,
    scopeApplyUrl: missingScopes.length > 0 ? buildLarkScopeApplyUrl(appId, missingScopes) : undefined,
    eventConfigUrl,
    publishedVersion: snapshot.version,
    publishedVersionId: snapshot.versionId,
    hasPublishedVersion: snapshot.hasPublishedVersion
  };
}

export function parseCurrentPublishedLarkAppVersion(raw: unknown): LarkAppVersionSnapshot {
  const items = asArray(asRecord(asRecord(raw).data).items);
  for (const item of items) {
    const record = asRecord(item);
    if (record.status !== 1 || !publishTimeSet(record.publish_time)) {
      continue;
    }
    const scopes = new Set<string>();
    for (const scope of asArray(record.scopes)) {
      const scopeRecord = asRecord(scope);
      const scopeName = asString(scopeRecord.scope);
      const tokenTypes = asArray(scopeRecord.token_types).map((tokenType) => asString(tokenType)).filter(Boolean);
      if (scopeName && (tokenTypes.length === 0 || tokenTypes.includes("tenant"))) {
        scopes.add(scopeName);
      }
    }

    const subscriptions = new Map<string, LarkEventSubscriptionState>();
    for (const eventInfo of asArray(record.event_infos)) {
      const eventRecord = asRecord(eventInfo);
      const eventType = asString(eventRecord.event_type);
      if (!eventType) {
        continue;
      }
      subscriptions.set(eventType, {
        eventType
      });
    }

    return {
      version: asString(record.version),
      versionId: asString(record.version_id),
      hasPublishedVersion: true,
      scopes,
      subscriptions
    };
  }

  return {
    hasPublishedVersion: false,
    scopes: new Set(),
    subscriptions: new Map()
  };
}

export function buildLarkScopeApplyUrl(appId: string, scopes: readonly string[]): string {
  return `${LARK_OPEN_CONSOLE_BASE_URL}/page/scope-apply?clientID=${encodeURIComponent(appId)}&scopes=${encodeURIComponent(scopes.join(","))}`;
}

export function buildLarkEventConfigUrl(
  appId: string,
  issues: { hasEventIssues: boolean; hasCallbackIssues: boolean }
): string | undefined {
  if (!issues.hasEventIssues && !issues.hasCallbackIssues) {
    return undefined;
  }
  const base = `${LARK_OPEN_CONSOLE_BASE_URL}/app/${encodeURIComponent(appId)}/event`;
  if (issues.hasEventIssues && issues.hasCallbackIssues) {
    return base;
  }
  return issues.hasEventIssues ? `${base}?tab=event` : `${base}?tab=callback`;
}

export function formatLarkFeatureCheckIssueText(
  result: LarkFeatureCheckResult,
  options: { usage?: "startup" | "group_non_at" | "doc_watch" } = {}
): string | undefined {
  if (result.ok || result.skipped) {
    return undefined;
  }

  const lines = [`${result.label}配置未满足。`];
  if (!result.hasPublishedVersion) {
    lines.push("应用还没有已发布版本，请发布应用版本后重试。");
  }

  if (
    options.usage === "doc_watch" &&
    isOnlyMissingDocMediaDownload(result)
  ) {
    lines.push("缺少 docs:document.media:download，bot 无法看到文档中的图片。");
  } else if (result.missingScopes.length > 0) {
    lines.push(`缺少权限：${result.missingScopes.join(", ")}`);
  }

  if (result.scopeApplyUrl && result.missingScopes.length > 0) {
    lines.push(`权限申请链接：${result.scopeApplyUrl}`);
  }
  if (result.missingEvents.length > 0) {
    lines.push(`缺少事件订阅：${result.missingEvents.join(", ")}`);
  }
  if (result.missingCallbacks.length > 0) {
    lines.push(`缺少回调订阅：${result.missingCallbacks.join(", ")}`);
  }
  if (result.nonLongConnectionEvents.length > 0) {
    lines.push(`事件需开启长连接模式：${result.nonLongConnectionEvents.join(", ")}`);
  }
  if (result.nonLongConnectionCallbacks.length > 0) {
    lines.push(`回调需开启长连接模式：${result.nonLongConnectionCallbacks.join(", ")}`);
  }
  if (result.eventConfigUrl) {
    lines.push(`事件/回调配置链接：${result.eventConfigUrl}`);
  }
  if (options.usage === "group_non_at") {
    lines.push("否则 bot 无法收到非 at 群消息。");
  }
  return lines.join("\n");
}

export function summarizeLarkFeatureCheckIssue(result: LarkFeatureCheckResult): string {
  if (result.skipped) {
    return `SKIP: ${result.skipReason ?? "unable to query Lark app configuration"}`;
  }
  if (result.ok) {
    return result.hasPublishedVersion && result.publishedVersion
      ? `${result.label}已满足，published version=${result.publishedVersion}`
      : `${result.label}已满足`;
  }
  const parts: string[] = [];
  if (!result.hasPublishedVersion) {
    parts.push("no published app version");
  }
  if (result.missingScopes.length > 0) {
    parts.push(`missing scopes: ${result.missingScopes.join(", ")}`);
  }
  if (result.missingEvents.length > 0) {
    parts.push(`missing events: ${result.missingEvents.join(", ")}`);
  }
  if (result.missingCallbacks.length > 0) {
    parts.push(`missing callbacks: ${result.missingCallbacks.join(", ")}`);
  }
  if (result.nonLongConnectionEvents.length > 0) {
    parts.push(`events not in long-connection mode: ${result.nonLongConnectionEvents.join(", ")}`);
  }
  if (result.nonLongConnectionCallbacks.length > 0) {
    parts.push(`callbacks not in long-connection mode: ${result.nonLongConnectionCallbacks.join(", ")}`);
  }
  if (result.scopeApplyUrl) {
    parts.push(`scope link: ${result.scopeApplyUrl}`);
  }
  if (result.eventConfigUrl) {
    parts.push(`event link: ${result.eventConfigUrl}`);
  }
  return parts.join("; ");
}

function isOnlyMissingDocMediaDownload(result: LarkFeatureCheckResult): boolean {
  return result.missingScopes.length === 1 &&
    result.missingScopes[0] === "docs:document.media:download" &&
    result.missingEvents.length === 0 &&
    result.missingCallbacks.length === 0 &&
    result.nonLongConnectionEvents.length === 0 &&
    result.nonLongConnectionCallbacks.length === 0;
}

function hasLarkScope(scope: string, grantedScopes: Set<string>): boolean {
  return grantedScopes.has(scope) || (LARK_FEATURE_SCOPE_ALTERNATIVES[scope]?.some((alternative) => grantedScopes.has(alternative)) ?? false);
}

function publishTimeSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
