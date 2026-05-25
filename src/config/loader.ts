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
  GUEST_PROFILE_NAME,
  HOST_PROFILE_NAME,
  NONE_PROFILE_NAME,
  type LarkMessageRedactionConfig,
  type LarkMessageRedactionStrategy,
  type LarkBrand,
  type PermissionsConfig,
  type ProfileConfig,
  type ProfileName,
  type RuntimePaths,
  type TelemetryConfig,
  type TwinnyAuthFile,
  type TwinnyConfig,
  type TwinnyHomeIdentity
} from "../types.js";
import { createRuntimePaths, expandHomePath, resolveTwinnyHome, type ResolveHomeOptions } from "./paths.js";
import { larkAppSecretAccountForHomeRandom } from "./secrets.js";

export const DEFAULT_PROFILE_MODEL = "gpt-5.5";
export const DEFAULT_PROFILE_EFFORT = "medium";
export const DEFAULT_POSTHOG_HOST = "https://app.posthog.com";

const redactionSchema = z.enum(["mask", "whitespace", "none"]);

const rawProfileSchema = z
  .object({
    codex_home: z.string().optional(),
    default_model: z.string().optional(),
    default_effort: z.string().optional()
  })
  .strict();

const rawConfigSchema = z
  .object({
    codex: z
      .object({
        binary: z.string().optional()
      })
      .strict()
      .optional(),
    lark: z
      .object({
        reaction: z
          .object({
            working: z.string().optional(),
            queued: z.string().optional()
          })
          .strict()
          .optional(),
        redaction: z
          .object({
            email: redactionSchema.optional(),
            chinese_phone_number: redactionSchema.optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    permissions: z
      .object({
        p2p_default_profile: z.string().optional()
      })
      .strict()
      .optional(),
    telemetry: z
      .object({
        enabled: z.boolean().optional(),
        posthog_api_key: z.string().optional(),
        posthog_host: z.string().optional()
      })
      .strict()
      .optional(),
    profiles: z.record(rawProfileSchema).optional()
  })
  .strict();

const rawAuthSchema = z
  .object({
    lark_app_id: z.string(),
    lark_brand: z.enum(["feishu", "lark"]).optional(),
    owner_open_id: z.string(),
    displayName: z.string()
  })
  .strict();

type RawProfileConfig = z.infer<typeof rawProfileSchema>;

export interface CreateTwinnyConfigInput {
  home: string;
  auth: TwinnyAuthFileInput;
  homeRandom: string;
  codex?: {
    binary?: string;
  };
  lark?: {
    workingReaction?: string;
    completedReaction?: string;
    queuedReaction?: string;
    maxMessageAgeSeconds?: number;
    messageRedaction?: Partial<LarkMessageRedactionConfig>;
  };
  permissions?: Partial<PermissionsConfig>;
  telemetry?: Partial<TelemetryConfig>;
  profiles?: Record<ProfileName, Partial<ProfileConfig>>;
}

type TwinnyAuthFileInput = Omit<TwinnyAuthFile, "larkBrand"> & Partial<Pick<TwinnyAuthFile, "larkBrand">>;

export interface ConfigStatus {
  paths: RuntimePaths;
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
  const homeIdentity = createTwinnyHomeIdentity(input.homeRandom);
  const profiles = resolveProfiles(input.profiles, home);
  const config: TwinnyConfig = {
    home,
    codex: {
      binary: normalizeOptionalString(input.codex?.binary) ?? "codex"
    },
    lark: {
      workingReaction: normalizeOptionalString(input.lark?.workingReaction) ?? DEFAULT_LARK_WORKING_REACTION,
      completedReaction: normalizeOptionalString(input.lark?.completedReaction) ?? DEFAULT_LARK_COMPLETED_REACTION,
      queuedReaction: normalizeOptionalString(input.lark?.queuedReaction) ?? DEFAULT_LARK_QUEUED_REACTION,
      maxMessageAgeSeconds: input.lark?.maxMessageAgeSeconds ?? DEFAULT_LARK_MAX_MESSAGE_AGE_SECONDS,
      messageRedaction: normalizeMessageRedactionConfig(input.lark?.messageRedaction)
    },
    auth: normalizeAuthFile(input.auth),
    homeIdentity,
    permissions: {
      p2pDefaultProfile: normalizeProfileName(input.permissions?.p2pDefaultProfile) ?? NONE_PROFILE_NAME
    },
    telemetry: normalizeTelemetryConfig(input.telemetry),
    owner: {
      openId: input.auth.ownerOpenId,
      displayName: input.auth.displayName
    },
    profiles
  };
  return config;
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
    throw new Error(`Twinny home is incomplete: ${status.issues.join("; ")}`);
  }
  return status.config;
}

export async function readConfigStatus(options: LoadConfigOptions = {}): Promise<ConfigStatus> {
  const home = path.resolve(expandHomePath(options.home ?? resolveTwinnyHome(options), options.homeDir));
  const paths = createRuntimePaths(home);
  const issues: string[] = [];

  let rawToml: string;
  try {
    rawToml = await fs.readFile(paths.configFile, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { paths, exists: false, complete: false, issues: ["config.toml does not exist"] };
    }
    throw error;
  }

  let auth: TwinnyAuthFile | undefined;
  try {
    auth = await readTwinnyAuthFile(paths.authFile);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      issues.push("auth.json does not exist");
    } else {
      throw error;
    }
  }

  let homeIdentity: TwinnyHomeIdentity | undefined;
  try {
    homeIdentity = await readTwinnyHomeIdentity(paths.homeRandomFile);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      issues.push("runtime/home-random does not exist");
    } else {
      throw error;
    }
  }

  const parsedConfig = parseTwinnyConfigFile(rawToml, { ...options, home });
  const config = createRuntimeConfig(parsedConfig, {
    home,
    auth: auth ?? emptyAuthFile(),
    homeIdentity: homeIdentity ?? createTwinnyHomeIdentity("0".repeat(32))
  });
  issues.push(...validateTwinnyConfig(config));

  return {
    paths,
    exists: true,
    complete: issues.length === 0,
    issues,
    config
  };
}

export function parseTwinnyConfig(rawToml: string, options: LoadConfigOptions = {}): TwinnyConfig {
  const home = path.resolve(expandHomePath(options.home ?? resolveTwinnyHome(options), options.homeDir));
  return createRuntimeConfig(parseTwinnyConfigFile(rawToml, { ...options, home }), {
    home,
    auth: emptyAuthFile(),
    homeIdentity: createTwinnyHomeIdentity("0".repeat(32))
  });
}

export async function writeTwinnyConfig(
  config: TwinnyConfig,
  configFile = createRuntimePaths(config.home).configFile
): Promise<void> {
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, serializeTwinnyConfig(config), { encoding: "utf8", mode: 0o600 });
}

export function serializeTwinnyConfig(config: TwinnyConfig): string {
  return stringify(toTomlDocument(config)) + "\n";
}

export async function readTwinnyAuthFile(authFile: string): Promise<TwinnyAuthFile> {
  const parsed = rawAuthSchema.parse(JSON.parse(await fs.readFile(authFile, "utf8")));
  return normalizeAuthFile({
    larkAppId: parsed.lark_app_id,
    larkBrand: parsed.lark_brand,
    ownerOpenId: parsed.owner_open_id,
    displayName: parsed.displayName
  });
}

export async function writeTwinnyAuthFile(auth: TwinnyAuthFile, authFile: string): Promise<void> {
  await fs.mkdir(path.dirname(authFile), { recursive: true });
  await fs.writeFile(authFile, serializeTwinnyAuthFile(auth), { encoding: "utf8", mode: 0o600 });
}

export function serializeTwinnyAuthFile(auth: TwinnyAuthFile): string {
  const normalized = normalizeAuthFile(auth);
  return JSON.stringify(
    {
      lark_app_id: normalized.larkAppId,
      lark_brand: normalized.larkBrand,
      owner_open_id: normalized.ownerOpenId,
      displayName: normalized.displayName
    },
    null,
    2
  ) + "\n";
}

export async function readTwinnyHomeIdentity(homeRandomFile: string): Promise<TwinnyHomeIdentity> {
  const value = (await fs.readFile(homeRandomFile, "utf8")).trim();
  return createTwinnyHomeIdentity(value);
}

export async function writeTwinnyHomeRandom(homeRandom: string, homeRandomFile: string): Promise<void> {
  await fs.mkdir(path.dirname(homeRandomFile), { recursive: true });
  await fs.writeFile(homeRandomFile, `${createTwinnyHomeIdentity(homeRandom).random}\n`, { encoding: "utf8", mode: 0o600 });
}

export function createTwinnyHomeIdentity(homeRandom: string): TwinnyHomeIdentity {
  const random = homeRandom.trim().toLowerCase();
  return {
    random,
    telemetryHashSalt: random,
    keychainAccounts: {
      larkAppSecret: larkAppSecretAccountForHomeRandom(random)
    }
  };
}

export function validateTwinnyConfig(config: TwinnyConfig): string[] {
  const issues: string[] = [];
  if (!config.home) issues.push("home is required");
  if (!config.codex.binary) issues.push("codex.binary is required");
  if (!config.auth.larkAppId) issues.push("auth.json lark_app_id is required");
  if (!config.auth.ownerOpenId) issues.push("auth.json owner_open_id is required");
  if (!config.auth.displayName) issues.push("auth.json displayName is required");
  if (!/^[0-9a-f]{32,64}$/.test(config.homeIdentity.random)) {
    issues.push("runtime/home-random must be 128-bit or 256-bit lowercase hex");
  }
  if (!config.lark.workingReaction) issues.push("lark.reaction.working is required");
  if (!config.lark.completedReaction) issues.push("lark completed reaction internal default is required");
  if (!config.lark.queuedReaction) issues.push("lark.reaction.queued is required");
  if (!Number.isFinite(config.lark.maxMessageAgeSeconds) || config.lark.maxMessageAgeSeconds <= 0) {
    issues.push("lark max message age internal default must be a positive number");
  }
  for (const [key, strategy] of Object.entries(config.lark.messageRedaction)) {
    if (!isMessageRedactionStrategy(strategy)) {
      issues.push(`lark.redaction.${key} must be mask, whitespace, or none`);
    }
  }
  if (!config.profiles[HOST_PROFILE_NAME]) {
    issues.push("profiles.host is required");
  }
  if (config.profiles[NONE_PROFILE_NAME]) {
    issues.push("profiles.none is reserved and must not be configured");
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!normalizeProfileName(name)) {
      issues.push(`profiles.${name} name is invalid`);
    }
    if (!profile.codexHome) {
      issues.push(`profiles.${name}.codex_home is required after defaults`);
    }
  }
  const p2pDefault = config.permissions.p2pDefaultProfile;
  if (!p2pDefault) {
    issues.push("permissions.p2p_default_profile is required after defaults");
  } else if (p2pDefault !== NONE_PROFILE_NAME && !config.profiles[p2pDefault]) {
    issues.push(`permissions.p2p_default_profile references unknown profile: ${p2pDefault}`);
  }
  return issues;
}

function parseTwinnyConfigFile(rawToml: string, options: LoadConfigOptions): z.infer<typeof rawConfigSchema> {
  void options;
  return rawConfigSchema.parse(parse(rawToml));
}

function createRuntimeConfig(
  parsed: z.infer<typeof rawConfigSchema>,
  runtime: { home: string; auth: TwinnyAuthFile; homeIdentity: TwinnyHomeIdentity }
): TwinnyConfig {
  const profiles = resolveProfiles(rawProfilesToCamel(parsed.profiles), runtime.home);
  const auth = normalizeAuthFile(runtime.auth);
  return {
    home: runtime.home,
    codex: {
      binary: normalizeOptionalString(parsed.codex?.binary) ?? "codex"
    },
    lark: {
      workingReaction: normalizeOptionalString(parsed.lark?.reaction?.working) ?? DEFAULT_LARK_WORKING_REACTION,
      completedReaction: DEFAULT_LARK_COMPLETED_REACTION,
      queuedReaction: normalizeOptionalString(parsed.lark?.reaction?.queued) ?? DEFAULT_LARK_QUEUED_REACTION,
      maxMessageAgeSeconds: DEFAULT_LARK_MAX_MESSAGE_AGE_SECONDS,
      messageRedaction: normalizeMessageRedactionConfig({
        email: parsed.lark?.redaction?.email,
        chinesePhoneNumber: parsed.lark?.redaction?.chinese_phone_number
      })
    },
    auth,
    homeIdentity: runtime.homeIdentity,
    permissions: {
      p2pDefaultProfile: normalizeProfileName(parsed.permissions?.p2p_default_profile) ?? NONE_PROFILE_NAME
    },
    telemetry: normalizeTelemetryConfig({
      enabled: parsed.telemetry?.enabled,
      posthogApiKey: parsed.telemetry?.posthog_api_key,
      posthogHost: parsed.telemetry?.posthog_host
    }),
    owner: {
      openId: auth.ownerOpenId,
      displayName: auth.displayName
    },
    profiles
  };
}

function rawProfilesToCamel(
  profiles: Record<string, RawProfileConfig> | undefined
): Record<string, Partial<ProfileConfig>> | undefined {
  if (!profiles) {
    return undefined;
  }
  const result: Record<string, Partial<ProfileConfig>> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    result[name] = {
      codexHome: profile.codex_home,
      defaultModel: profile.default_model,
      defaultEffort: profile.default_effort
    };
  }
  return result;
}

function resolveProfiles(
  input: Record<ProfileName, Partial<ProfileConfig>> | undefined,
  home: string
): Record<ProfileName, ProfileConfig> {
  const hostInput = input?.[HOST_PROFILE_NAME] ?? {};
  const host: ProfileConfig = {
    codexHome: resolveConfigPath(hostInput.codexHome ?? "~/.codex", home),
    defaultModel: normalizeOptionalString(hostInput.defaultModel) ?? DEFAULT_PROFILE_MODEL,
    defaultEffort: normalizeOptionalString(hostInput.defaultEffort) ?? DEFAULT_PROFILE_EFFORT
  };
  const result: Record<ProfileName, ProfileConfig> = {
    [HOST_PROFILE_NAME]: host
  };
  const profileNames = new Set([GUEST_PROFILE_NAME, ...Object.keys(input ?? {})]);
  for (const name of profileNames) {
    if (name === HOST_PROFILE_NAME || name === NONE_PROFILE_NAME) {
      continue;
    }
    const profileInput = input?.[name] ?? {};
    result[name] = {
      codexHome: resolveConfigPath(profileInput.codexHome ?? host.codexHome, home),
      defaultModel: normalizeOptionalString(profileInput.defaultModel) ?? host.defaultModel,
      defaultEffort: normalizeOptionalString(profileInput.defaultEffort) ?? host.defaultEffort
    };
  }
  return result;
}

function toTomlDocument(config: TwinnyConfig): TomlTable {
  const profiles: TomlTable = {};
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (name === NONE_PROFILE_NAME) {
      continue;
    }
    const table: TomlTable = {};
    if (name === HOST_PROFILE_NAME || profile.codexHome !== config.profiles[HOST_PROFILE_NAME]?.codexHome) {
      table.codex_home = profile.codexHome;
    }
    if (name === HOST_PROFILE_NAME || profile.defaultModel !== config.profiles[HOST_PROFILE_NAME]?.defaultModel) {
      table.default_model = profile.defaultModel ?? "";
    }
    if (name === HOST_PROFILE_NAME || profile.defaultEffort !== config.profiles[HOST_PROFILE_NAME]?.defaultEffort) {
      table.default_effort = profile.defaultEffort ?? "";
    }
    profiles[name] = table;
  }
  profiles[GUEST_PROFILE_NAME] ??= {};

  const document: TomlTable = {
    codex: {
      binary: config.codex.binary
    },
    lark: {
      reaction: {
        working: config.lark.workingReaction,
        queued: config.lark.queuedReaction
      },
      redaction: {
        email: config.lark.messageRedaction.email,
        chinese_phone_number: config.lark.messageRedaction.chinesePhoneNumber
      }
    },
    permissions: {
      p2p_default_profile: config.permissions.p2pDefaultProfile
    },
    profiles
  };
  if (
    config.telemetry?.enabled ||
    config.telemetry?.posthogApiKey ||
    (config.telemetry?.posthogHost && config.telemetry.posthogHost !== DEFAULT_POSTHOG_HOST)
  ) {
    document.telemetry = {
      enabled: config.telemetry.enabled,
      posthog_host: config.telemetry.posthogHost
    };
    if (config.telemetry.posthogApiKey) {
      (document.telemetry as TomlTable).posthog_api_key = config.telemetry.posthogApiKey;
    }
  }
  return document;
}

function normalizeAuthFile(input: TwinnyAuthFileInput): TwinnyAuthFile {
  return {
    larkAppId: input.larkAppId.trim(),
    larkBrand: normalizeLarkBrand(input.larkBrand),
    ownerOpenId: input.ownerOpenId.trim(),
    displayName: input.displayName.trim()
  };
}

function emptyAuthFile(): TwinnyAuthFile {
  return {
    larkAppId: "",
    larkBrand: "feishu",
    ownerOpenId: "",
    displayName: ""
  };
}

function normalizeLarkBrand(value: LarkBrand | undefined): LarkBrand {
  return value === "lark" ? "lark" : "feishu";
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

function normalizeProfileName(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized || !/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    return undefined;
  }
  return normalized;
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

function normalizeTelemetryConfig(input: Partial<TelemetryConfig> | undefined): TelemetryConfig {
  const posthogApiKey = normalizeOptionalString(input?.posthogApiKey);
  const posthogHost = normalizeOptionalString(input?.posthogHost) ?? DEFAULT_POSTHOG_HOST;
  return {
    enabled: input?.enabled ?? Boolean(posthogApiKey),
    ...(posthogApiKey ? { posthogApiKey } : {}),
    posthogHost
  };
}

function isMessageRedactionStrategy(value: unknown): value is LarkMessageRedactionStrategy {
  return value === "mask" || value === "whitespace" || value === "none";
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
