import fs from "node:fs/promises";
import path from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { z } from "zod";
import {
  DEFAULT_LARK_COMPLETED_REACTION,
  DEFAULT_LARK_MAX_MESSAGE_AGE_SECONDS,
  DEFAULT_LARK_MESSAGE_REDACTION_STRATEGY,
  DEFAULT_LARK_QUEUED_REACTION,
  DEFAULT_LARK_WORKING_REACTION,
  type LarkMessageRedactionConfig,
  type LarkMessageRedactionStrategy,
  type RoleName,
  type TwinnyConfig
} from "../types.js";
import { createRuntimePaths, expandHomePath, resolveTwinnyHome, type ResolveHomeOptions } from "./paths.js";
import { SECRET_REFS } from "./secrets.js";

const rawConfigSchema = z.object({
  home: z.object({ path: z.string().optional() }).optional(),
  codex: z
    .object({
      binary: z.string().optional(),
      app_server_listen: z.literal("stdio://").optional()
    })
    .optional(),
  lark: z
    .object({
      identity: z.literal("bot").optional(),
      app_id: z.string().optional(),
      event_key: z.literal("im.message.receive_v1").optional(),
      secret_ref: z.string().optional(),
      working_reaction: z.string().optional(),
      completed_reaction: z.string().optional(),
      queued_reaction: z.string().optional(),
      max_message_age_seconds: z.number().optional(),
      icon_image_key: z.string().optional(),
      redaction: z
        .object({
          email: z.enum(["mask", "whitespace", "none"]).optional(),
          chinese_phone_number: z.enum(["mask", "whitespace", "none"]).optional()
        })
        .optional()
    })
    .optional(),
  owner: z
    .object({
      open_id: z.string().optional(),
      user_id: z.string().optional(),
      display_name: z.string().optional(),
      token_ref: z.string().optional(),
      refresh_token_ref: z.string().optional()
    })
    .optional(),
  roles: z
    .object({
      owner: z.object({ codex_home: z.string().optional() }).optional(),
      guest: z.object({ codex_home: z.string().optional() }).optional()
    })
    .optional()
});

export interface CreateTwinnyConfigInput {
  home: string;
  lark: {
    appId: string;
    appSecretRef?: string;
    workingReaction?: string;
    completedReaction?: string;
    queuedReaction?: string;
    maxMessageAgeSeconds?: number;
    iconImageKey?: string;
    messageRedaction?: Partial<LarkMessageRedactionConfig>;
  };
  owner: {
    openId: string;
    userId?: string;
    displayName: string;
    tokenRef?: string;
    refreshTokenRef?: string;
  };
  codex?: {
    binary?: string;
    appServerListen?: "stdio://";
  };
  roles?: Partial<Record<RoleName, { codexHome: string }>>;
}

export interface ConfigStatus {
  paths: ReturnType<typeof createRuntimePaths>;
  exists: boolean;
  complete: boolean;
  issues: string[];
  config?: TwinnyConfig;
}

export type LoadConfigOptions = ResolveHomeOptions & {
  home?: string;
};

export function createTwinnyConfig(input: CreateTwinnyConfigInput): TwinnyConfig {
  const home = path.resolve(expandHomePath(input.home));
  const paths = createRuntimePaths(home);

  return {
    home,
    codex: {
      binary: input.codex?.binary ?? "codex",
      appServerListen: input.codex?.appServerListen ?? "stdio://"
    },
    lark: {
      appId: input.lark.appId,
      appSecretRef: input.lark.appSecretRef ?? SECRET_REFS.larkAppSecret,
      eventKey: "im.message.receive_v1",
      identity: "bot",
      workingReaction: normalizeOptionalString(input.lark.workingReaction) ?? DEFAULT_LARK_WORKING_REACTION,
      completedReaction: normalizeOptionalString(input.lark.completedReaction) ?? DEFAULT_LARK_COMPLETED_REACTION,
      queuedReaction: normalizeOptionalString(input.lark.queuedReaction) ?? DEFAULT_LARK_QUEUED_REACTION,
      maxMessageAgeSeconds: input.lark.maxMessageAgeSeconds ?? DEFAULT_LARK_MAX_MESSAGE_AGE_SECONDS,
      iconImageKey: normalizeOptionalString(input.lark.iconImageKey),
      messageRedaction: normalizeMessageRedactionConfig(input.lark.messageRedaction)
    },
    owner: {
      openId: input.owner.openId,
      userId: input.owner.userId,
      displayName: input.owner.displayName,
      tokenRef: input.owner.tokenRef ?? SECRET_REFS.ownerUserToken,
      refreshTokenRef: input.owner.refreshTokenRef
    },
    roles: {
      owner: { codexHome: input.roles?.owner?.codexHome ?? paths.ownerCodexHome },
      guest: { codexHome: input.roles?.guest?.codexHome ?? paths.guestCodexHome }
    }
  };
}

export async function loadTwinnyConfig(options: LoadConfigOptions = {}): Promise<TwinnyConfig> {
  const status = await readConfigStatus(options);
  if (!status.exists) {
    throw new Error(`Twinny config not found at ${status.paths.configFile}`);
  }
  if (!status.config) {
    throw new Error(`Twinny config could not be parsed at ${status.paths.configFile}`);
  }
  if (!status.complete) {
    throw new Error(`Twinny config is incomplete: ${status.issues.join("; ")}`);
  }
  return status.config;
}

export async function readConfigStatus(options: LoadConfigOptions = {}): Promise<ConfigStatus> {
  const home = path.resolve(expandHomePath(options.home ?? resolveTwinnyHome(options), options.homeDir));
  const paths = createRuntimePaths(home);

  let rawToml: string;
  try {
    rawToml = await fs.readFile(paths.configFile, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { paths, exists: false, complete: false, issues: ["config.toml does not exist"] };
    }
    throw error;
  }

  const config = parseTwinnyConfig(rawToml, { ...options, home });
  applyEnvironmentOverrides(config, options.env ?? process.env);
  const issues = validateTwinnyConfig(config);

  return {
    paths,
    exists: true,
    complete: issues.length === 0,
    issues,
    config
  };
}

export function parseTwinnyConfig(rawToml: string, options: LoadConfigOptions = {}): TwinnyConfig {
  const parsed = rawConfigSchema.parse(parse(rawToml));
  const home = path.resolve(
    expandHomePath(parsed.home?.path ?? options.home ?? resolveTwinnyHome(options), options.homeDir)
  );
  const paths = createRuntimePaths(home);

  return {
    home,
    codex: {
      binary: parsed.codex?.binary ?? "codex",
      appServerListen: parsed.codex?.app_server_listen ?? "stdio://"
    },
    lark: {
      appId: parsed.lark?.app_id ?? "",
      appSecretRef: parsed.lark?.secret_ref ?? SECRET_REFS.larkAppSecret,
      eventKey: parsed.lark?.event_key ?? "im.message.receive_v1",
      identity: parsed.lark?.identity ?? "bot",
      workingReaction: normalizeOptionalString(parsed.lark?.working_reaction) ?? DEFAULT_LARK_WORKING_REACTION,
      completedReaction: normalizeOptionalString(parsed.lark?.completed_reaction) ?? DEFAULT_LARK_COMPLETED_REACTION,
      queuedReaction: normalizeOptionalString(parsed.lark?.queued_reaction) ?? DEFAULT_LARK_QUEUED_REACTION,
      maxMessageAgeSeconds: parsed.lark?.max_message_age_seconds ?? DEFAULT_LARK_MAX_MESSAGE_AGE_SECONDS,
      iconImageKey: normalizeOptionalString(parsed.lark?.icon_image_key),
      messageRedaction: normalizeMessageRedactionConfig({
        email: parsed.lark?.redaction?.email,
        chinesePhoneNumber: parsed.lark?.redaction?.chinese_phone_number
      })
    },
    owner: {
      openId: parsed.owner?.open_id ?? "",
      userId: parsed.owner?.user_id,
      displayName: parsed.owner?.display_name ?? "",
      tokenRef: parsed.owner?.token_ref ?? SECRET_REFS.ownerUserToken,
      refreshTokenRef: parsed.owner?.refresh_token_ref
    },
    roles: {
      owner: { codexHome: resolveConfigPath(parsed.roles?.owner?.codex_home ?? paths.ownerCodexHome, home) },
      guest: { codexHome: resolveConfigPath(parsed.roles?.guest?.codex_home ?? paths.guestCodexHome, home) }
    }
  };
}

export async function writeTwinnyConfig(config: TwinnyConfig, configFile = createRuntimePaths(config.home).configFile): Promise<void> {
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, serializeTwinnyConfig(config), { encoding: "utf8", mode: 0o600 });
}

export async function writeLarkIconImageKey(
  config: TwinnyConfig,
  iconImageKey: string,
  configFile = createRuntimePaths(config.home).configFile
): Promise<void> {
  const normalized = normalizeOptionalString(iconImageKey);
  if (!normalized) {
    throw new Error("iconImageKey is required");
  }
  config.lark.iconImageKey = normalized;

  let rawToml = "";
  try {
    rawToml = await fs.readFile(configFile, "utf8");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }

  const nextToml = rawToml ? patchLarkIconImageKey(rawToml, normalized) : serializeTwinnyConfig(config);
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  const tempFile = `${configFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, nextToml, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempFile, configFile);
}

export function serializeTwinnyConfig(config: TwinnyConfig): string {
  return stringify(toTomlDocument(config)) + "\n";
}

export function validateTwinnyConfig(config: TwinnyConfig): string[] {
  const issues: string[] = [];
  if (!config.home) issues.push("home.path is required");
  if (!config.codex.binary) issues.push("codex.binary is required");
  if (config.codex.appServerListen !== "stdio://") issues.push("codex.app_server_listen must be stdio://");
  if (!config.lark.appId) issues.push("lark.app_id is required");
  if (!config.lark.appSecretRef) issues.push("lark.secret_ref is required");
  if (config.lark.identity !== "bot") issues.push("lark.identity must be bot");
  if (config.lark.eventKey !== "im.message.receive_v1") issues.push("lark.event_key must be im.message.receive_v1");
  if (!config.lark.workingReaction) issues.push("lark.working_reaction is required");
  if (!config.lark.completedReaction) issues.push("lark.completed_reaction is required");
  if (!config.lark.queuedReaction) issues.push("lark.queued_reaction is required");
  if (!Number.isFinite(config.lark.maxMessageAgeSeconds) || config.lark.maxMessageAgeSeconds <= 0) {
    issues.push("lark.max_message_age_seconds must be a positive number");
  }
  for (const [key, strategy] of Object.entries(config.lark.messageRedaction)) {
    if (!isMessageRedactionStrategy(strategy)) {
      issues.push(`lark.redaction.${key} must be mask, whitespace, or none`);
    }
  }
  if (!config.owner.openId) issues.push("owner.open_id is required");
  if (!config.owner.displayName) issues.push("owner.display_name is required");
  if (!config.owner.tokenRef) issues.push("owner.token_ref is required");
  if (!config.roles.owner.codexHome) issues.push("roles.owner.codex_home is required");
  if (!config.roles.guest.codexHome) issues.push("roles.guest.codex_home is required");
  return issues;
}

function applyEnvironmentOverrides(config: TwinnyConfig, env: NodeJS.ProcessEnv): void {
  if (env.TWINNY_LARK_APP_ID) {
    config.lark.appId = env.TWINNY_LARK_APP_ID;
  }
}

function toTomlDocument(config: TwinnyConfig): TomlTable {
  const owner: TomlTable = {
    open_id: config.owner.openId,
    display_name: config.owner.displayName
  };
  if (config.owner.tokenRef) {
    owner.token_ref = config.owner.tokenRef;
  }
  if (config.owner.userId) {
    owner.user_id = config.owner.userId;
  }
  if (config.owner.refreshTokenRef) {
    owner.refresh_token_ref = config.owner.refreshTokenRef;
  }

  return {
    home: {
      path: config.home
    },
    codex: {
      binary: config.codex.binary,
      app_server_listen: config.codex.appServerListen
    },
    lark: {
      identity: config.lark.identity,
      app_id: config.lark.appId,
      event_key: config.lark.eventKey,
      secret_ref: config.lark.appSecretRef,
      working_reaction: config.lark.workingReaction,
      completed_reaction: config.lark.completedReaction,
      queued_reaction: config.lark.queuedReaction,
      max_message_age_seconds: config.lark.maxMessageAgeSeconds,
      ...(config.lark.iconImageKey ? { icon_image_key: config.lark.iconImageKey } : {}),
      redaction: {
        email: config.lark.messageRedaction.email,
        chinese_phone_number: config.lark.messageRedaction.chinesePhoneNumber
      }
    },
    owner,
    roles: {
      owner: {
        codex_home: config.roles.owner.codexHome
      },
      guest: {
        codex_home: config.roles.guest.codexHome
      }
    }
  };
}

function resolveConfigPath(value: string, home: string): string {
  const expanded = expandHomePath(value);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(home, expanded);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeMessageRedactionConfig(
  input: Partial<LarkMessageRedactionConfig> | undefined
): LarkMessageRedactionConfig {
  return {
    email: normalizeMessageRedactionStrategy(input?.email),
    chinesePhoneNumber: normalizeMessageRedactionStrategy(input?.chinesePhoneNumber)
  };
}

function normalizeMessageRedactionStrategy(
  strategy: LarkMessageRedactionStrategy | undefined
): LarkMessageRedactionStrategy {
  return strategy ?? DEFAULT_LARK_MESSAGE_REDACTION_STRATEGY;
}

function isMessageRedactionStrategy(value: unknown): value is LarkMessageRedactionStrategy {
  return value === "mask" || value === "whitespace" || value === "none";
}

function patchLarkIconImageKey(rawToml: string, iconImageKey: string): string {
  const lines = rawToml.split(/\r?\n/);
  const larkHeaderIndex = lines.findIndex((line) => /^\s*\[lark]\s*(?:#.*)?$/.test(line));
  const rendered = `icon_image_key = ${JSON.stringify(iconImageKey)}`;
  if (larkHeaderIndex < 0) {
    const suffix = rawToml.endsWith("\n") ? "" : "\n";
    return `${rawToml}${suffix}\n[lark]\n${rendered}\n`;
  }

  let insertIndex = lines.length;
  for (let index = larkHeaderIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+]\s*(?:#.*)?$/.test(lines[index]!)) {
      insertIndex = index;
      break;
    }
    if (/^\s*icon_image_key\s*=/.test(lines[index]!)) {
      lines[index] = rendered;
      return lines.join("\n");
    }
  }

  lines.splice(insertIndex, 0, rendered);
  return lines.join("\n");
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
