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
  DEFAULT_CONVERSATION_WORKSPACE_TEMPLATE,
  GUEST_PROFILE_NAME,
  HOST_PROFILE_NAME,
  NONE_PROFILE_NAME,
  type GreetingConfig,
  type GreetingMode,
  type GreetingTargetConfig,
  type HarnessConfig,
  type HarnessKind,
  type LarkMessageRedactionConfig,
  type LarkMessageRedactionStrategy,
  type LarkCliProfileConfig,
  type LarkBrand,
  type ConversationResponseMode,
  type LaunchdServiceConfig,
  type PermissionsConfig,
  type ProfileConfig,
  type ProfileName,
  type RuntimePaths,
  type ServiceConfig,
  type TelemetryConfig,
  type TwinnyAuthFile,
  type TwinnyConfig,
  type TwinnyHomeIdentity,
  type UpgradeChannel,
  type UpgradeConfig
} from "../types.js";
import { createRuntimePaths, expandHomePath, resolveTwinnyHome, type ResolveHomeOptions } from "./paths.js";
import { larkAppSecretAccountForHomeRandom } from "./secrets.js";

export const DEFAULT_PROFILE_MODEL = "gpt-5.5";
export const DEFAULT_PROFILE_EFFORT = "medium";
export const DEFAULT_HARNESS: HarnessKind = "codex";
export const DEFAULT_CLAUDE_BINARY = "claude";
export const DEFAULT_CLAUDE_MODEL = "sonnet";
export const DEFAULT_CLAUDE_EFFORT = "high";
export const DEFAULT_POSTHOG_PROJECT_TOKEN = "phc_yXXd2mi9J33Awy7vs8VY8UbEoYdtXPnKs87YWxnRAnN8";
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
export const DEFAULT_UPGRADE_CHANNEL: UpgradeChannel = "stable";
export const DEFAULT_UPGRADE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_UPGRADE_AUTO_UPDATE = true;

const HARNESS_EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh"]);

const redactionSchema = z.enum(["mask", "whitespace", "none"]);
const greetingModeSchema = z.enum(["none", "text", "codex_turn"]);
const upgradeChannelSchema = z.enum(["stable", "beta"]);
const upgradeIntervalSchema = z.union([
  z.number().positive(),
  z.string().regex(/^\s*[1-9]\d*(?:ms|s|m|h|d)?\s*$/i)
]);

const rawProfileSchema = z
  .object({
    codex_home: z.string().optional(),
    default_model: z.string().optional(),
    default_effort: z.string().optional(),
    claude_config_dir: z.string().optional()
  })
  .strict();

const harnessKindSchema = z.enum(["codex", "claude"]);

const rawHarnessSchema = z
  .object({
    default: harnessKindSchema.optional(),
    codex: z
      .object({
        default_model: z.string().optional(),
        default_effort: z.string().optional()
      })
      .strict()
      .optional(),
    claude: z
      .object({
        binary: z.string().optional(),
        default_model: z.string().optional(),
        default_effort: z.string().optional()
      })
      .strict()
      .optional()
  })
  .strict();

const rawConfigSchema = z
  .object({
    codex: z
      .object({
        binary: z.string().optional(),
        masquerade_as_codex_cli: z.boolean().optional()
      })
      .strict()
      .optional(),
    harness: rawHarnessSchema.optional(),
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
        p2p_default_profile: z.string().optional(),
        p2p_default_workspace: z.string().optional(),
        group_default_profile: z.string().optional(),
        group_default_mode: z.enum(["all", "all_at", "owner", "owner_at", "none"]).optional(),
        group_default_workspace: z.string().optional()
      })
      .strict()
      .optional(),
    greeting: z
      .object({
        p2p: z
          .object({
            mode: greetingModeSchema.optional(),
            message: z.string().optional()
          })
          .strict()
          .optional(),
        group: z
          .object({
            mode: greetingModeSchema.optional(),
            message: z.string().optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    service: z
      .object({
        launchd: z
          .object({
            mode: z.enum(["gui", "daemon"]).optional(),
            user_name: z.string().optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    upgrade: z
      .object({
        channel: upgradeChannelSchema.optional(),
        check_interval: upgradeIntervalSchema.optional(),
        auto_update: z.boolean().optional(),
        registry: z.string().optional()
      })
      .strict()
      .optional(),
    telemetry: z
      .object({
        enabled: z.boolean().optional(),
        posthog_project_token: z.string().optional(),
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
    lark_app_secret: z.string().optional(),
    lark_brand: z.enum(["feishu", "lark"]).optional(),
    owner_open_id: z.string(),
    displayName: z.string()
  })
  .strict();

const rawLarkCliProfileSchema = z
  .object({
    profileName: z.string()
  })
  .strict();

type RawProfileConfig = z.infer<typeof rawProfileSchema>;

export interface CreateTwinnyConfigInput {
  home: string;
  auth: TwinnyAuthFileInput;
  homeRandom: string;
  codex?: {
    binary?: string;
    masqueradeAsCodexCli?: boolean;
  };
  harness?: {
    default?: HarnessKind;
    codex?: {
      defaultModel?: string;
      defaultEffort?: string;
    };
    claude?: {
      binary?: string;
      defaultModel?: string;
      defaultEffort?: string;
    };
  };
  lark?: {
    workingReaction?: string;
    completedReaction?: string;
    queuedReaction?: string;
    maxMessageAgeSeconds?: number;
    messageRedaction?: Partial<LarkMessageRedactionConfig>;
  };
  permissions?: Partial<PermissionsConfig>;
  greeting?: {
    p2p?: Partial<GreetingTargetConfig>;
    group?: Partial<GreetingTargetConfig>;
  };
  service?: {
    launchd?: Partial<LaunchdServiceConfig>;
  };
  upgrade?: Partial<UpgradeConfig>;
  telemetry?: Partial<TelemetryConfig>;
  larkCliProfile?: LarkCliProfileConfig;
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
      binary: normalizeOptionalString(input.codex?.binary) ?? "codex",
      masqueradeAsCodexCli: input.codex?.masqueradeAsCodexCli ?? false
    },
    harness: normalizeHarnessConfig(input.harness),
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
      p2pDefaultProfile: normalizeProfileName(input.permissions?.p2pDefaultProfile) ?? NONE_PROFILE_NAME,
      p2pDefaultWorkspace: normalizeWorkspaceTemplate(input.permissions?.p2pDefaultWorkspace),
      groupDefaultProfile: normalizeProfileName(input.permissions?.groupDefaultProfile) ?? NONE_PROFILE_NAME,
      groupDefaultMode: normalizeGroupDefaultMode(input.permissions?.groupDefaultMode),
      groupDefaultWorkspace: normalizeWorkspaceTemplate(input.permissions?.groupDefaultWorkspace)
    },
    greeting: normalizeGreetingConfig(input.greeting),
    service: normalizeServiceConfig(input.service),
    upgrade: normalizeUpgradeConfig(input.upgrade),
    telemetry: normalizeTelemetryConfig(input.telemetry),
    larkCliProfile: normalizeLarkCliProfileConfig(input.larkCliProfile),
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

  const larkCliProfile = await readLarkCliProfileConfig(paths.larkCliProfileFile);
  const parsedConfig = parseTwinnyConfigFile(rawToml, { ...options, home });
  const config = createRuntimeConfig(parsedConfig, {
    home,
    auth: auth ?? emptyAuthFile(),
    homeIdentity: homeIdentity ?? createTwinnyHomeIdentity("0".repeat(32)),
    larkCliProfile
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
    larkAppSecret: parsed.lark_app_secret,
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
      ...(normalized.larkAppSecret ? { lark_app_secret: normalized.larkAppSecret } : {}),
      lark_brand: normalized.larkBrand,
      owner_open_id: normalized.ownerOpenId,
      displayName: normalized.displayName
    },
    null,
    2
  ) + "\n";
}

export async function readLarkCliProfileConfig(profileFile: string): Promise<LarkCliProfileConfig | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(profileFile, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  return normalizeLarkCliProfileConfig(rawLarkCliProfileSchema.parse(JSON.parse(raw)));
}

export async function writeLarkCliProfileConfig(profile: LarkCliProfileConfig, profileFile: string): Promise<void> {
  const normalized = normalizeLarkCliProfileConfig(profile);
  if (!normalized) {
    throw new Error("lark-cli profile name is required");
  }
  await fs.mkdir(path.dirname(profileFile), { recursive: true });
  await fs.writeFile(profileFile, JSON.stringify({ profileName: normalized.profileName }, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600
  });
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
  if (!config.harness.claude.binary) issues.push("harness.claude.binary is required after defaults");
  if (config.harness.codex.defaultEffort && !HARNESS_EFFORT_VALUES.has(config.harness.codex.defaultEffort)) {
    issues.push("harness.codex.default_effort must be low, medium, high, or xhigh");
  }
  if (!HARNESS_EFFORT_VALUES.has(config.harness.claude.defaultEffort)) {
    issues.push("harness.claude.default_effort must be low, medium, high, or xhigh");
  }
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
  if (config.service.launchd.mode === "daemon" && !config.service.launchd.userName) {
    issues.push("service.launchd.user_name is required when service.launchd.mode is daemon");
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
  issues.push(...validateWorkspaceTemplate(config.permissions.p2pDefaultWorkspace, "permissions.p2p_default_workspace"));
  const groupDefaultProfile = config.permissions.groupDefaultProfile;
  if (!groupDefaultProfile) {
    issues.push("permissions.group_default_profile is required after defaults");
  } else if (groupDefaultProfile !== NONE_PROFILE_NAME && !config.profiles[groupDefaultProfile]) {
    issues.push(`permissions.group_default_profile references unknown profile: ${groupDefaultProfile}`);
  }
  const groupDefaultMode = config.permissions.groupDefaultMode;
  if (!isConversationResponseMode(groupDefaultMode)) {
    issues.push("permissions.group_default_mode must be owner_at, owner, all_at, all, or none");
  }
  issues.push(...validateWorkspaceTemplate(config.permissions.groupDefaultWorkspace, "permissions.group_default_workspace"));
  issues.push(...validateGreetingTargetConfig(config.greeting.p2p, "greeting.p2p"));
  issues.push(...validateGreetingTargetConfig(config.greeting.group, "greeting.group"));
  issues.push(...validateUpgradeConfig(config.upgrade));
  return issues;
}

function parseTwinnyConfigFile(rawToml: string, options: LoadConfigOptions): z.infer<typeof rawConfigSchema> {
  void options;
  return rawConfigSchema.parse(parse(rawToml));
}

function createRuntimeConfig(
  parsed: z.infer<typeof rawConfigSchema>,
  runtime: { home: string; auth: TwinnyAuthFile; homeIdentity: TwinnyHomeIdentity; larkCliProfile?: LarkCliProfileConfig }
): TwinnyConfig {
  const profiles = resolveProfiles(rawProfilesToCamel(parsed.profiles), runtime.home);
  const auth = normalizeAuthFile(runtime.auth);
  return {
    home: runtime.home,
    codex: {
      binary: normalizeOptionalString(parsed.codex?.binary) ?? "codex",
      masqueradeAsCodexCli: parsed.codex?.masquerade_as_codex_cli ?? false
    },
    harness: normalizeHarnessConfig({
      default: parsed.harness?.default,
      codex: {
        defaultModel: parsed.harness?.codex?.default_model,
        defaultEffort: parsed.harness?.codex?.default_effort
      },
      claude: {
        binary: parsed.harness?.claude?.binary,
        defaultModel: parsed.harness?.claude?.default_model,
        defaultEffort: parsed.harness?.claude?.default_effort
      }
    }),
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
      p2pDefaultProfile: normalizeProfileName(parsed.permissions?.p2p_default_profile) ?? NONE_PROFILE_NAME,
      p2pDefaultWorkspace: normalizeWorkspaceTemplate(parsed.permissions?.p2p_default_workspace),
      groupDefaultProfile: normalizeProfileName(parsed.permissions?.group_default_profile) ?? NONE_PROFILE_NAME,
      groupDefaultMode: normalizeGroupDefaultMode(parsed.permissions?.group_default_mode),
      groupDefaultWorkspace: normalizeWorkspaceTemplate(parsed.permissions?.group_default_workspace)
    },
    greeting: normalizeGreetingConfig({
      p2p: {
        mode: parsed.greeting?.p2p?.mode,
        message: parsed.greeting?.p2p?.message
      },
      group: {
        mode: parsed.greeting?.group?.mode,
        message: parsed.greeting?.group?.message
      }
    }),
    service: normalizeServiceConfig({
      launchd: {
        mode: parsed.service?.launchd?.mode,
        userName: parsed.service?.launchd?.user_name
      }
    }),
    upgrade: normalizeUpgradeConfig({
      channel: parsed.upgrade?.channel,
      checkIntervalMs: parseUpgradeInterval(parsed.upgrade?.check_interval),
      autoUpdate: parsed.upgrade?.auto_update,
      registry: parsed.upgrade?.registry
    }),
    telemetry: normalizeTelemetryConfig({
      enabled: parsed.telemetry?.enabled,
      posthogProjectToken: parsed.telemetry?.posthog_project_token,
      posthogHost: parsed.telemetry?.posthog_host
    }),
    larkCliProfile: normalizeLarkCliProfileConfig(runtime.larkCliProfile),
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
      defaultEffort: profile.default_effort,
      claudeConfigDir: profile.claude_config_dir
    };
  }
  return result;
}

function normalizeHarnessConfig(
  input:
    | {
        default?: HarnessKind;
        codex?: { defaultModel?: string; defaultEffort?: string };
        claude?: { binary?: string; defaultModel?: string; defaultEffort?: string };
      }
    | undefined
): HarnessConfig {
  const codexModel = normalizeOptionalString(input?.codex?.defaultModel);
  const codexEffort = normalizeOptionalString(input?.codex?.defaultEffort);
  return {
    default: input?.default === "claude" ? "claude" : DEFAULT_HARNESS,
    codex: {
      ...(codexModel ? { defaultModel: codexModel } : {}),
      ...(codexEffort ? { defaultEffort: codexEffort } : {})
    },
    claude: {
      binary: normalizeOptionalString(input?.claude?.binary) ?? DEFAULT_CLAUDE_BINARY,
      defaultModel: normalizeOptionalString(input?.claude?.defaultModel) ?? DEFAULT_CLAUDE_MODEL,
      defaultEffort: normalizeOptionalString(input?.claude?.defaultEffort) ?? DEFAULT_CLAUDE_EFFORT
    }
  };
}

function resolveProfiles(
  input: Record<ProfileName, Partial<ProfileConfig>> | undefined,
  home: string
): Record<ProfileName, ProfileConfig> {
  const hostInput = input?.[HOST_PROFILE_NAME] ?? {};
  const hostClaudeConfigDir = normalizeOptionalString(hostInput.claudeConfigDir);
  const host: ProfileConfig = {
    codexHome: resolveConfigPath(hostInput.codexHome ?? "~/.codex", home),
    defaultModel: normalizeOptionalString(hostInput.defaultModel) ?? DEFAULT_PROFILE_MODEL,
    defaultEffort: normalizeOptionalString(hostInput.defaultEffort) ?? DEFAULT_PROFILE_EFFORT,
    ...(hostClaudeConfigDir ? { claudeConfigDir: resolveConfigPath(hostClaudeConfigDir, home) } : {})
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
    const claudeConfigDir = normalizeOptionalString(profileInput.claudeConfigDir);
    result[name] = {
      codexHome: resolveConfigPath(profileInput.codexHome ?? host.codexHome, home),
      defaultModel: normalizeOptionalString(profileInput.defaultModel) ?? host.defaultModel,
      defaultEffort: normalizeOptionalString(profileInput.defaultEffort) ?? host.defaultEffort,
      ...(claudeConfigDir ? { claudeConfigDir: resolveConfigPath(claudeConfigDir, home) } : {})
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
    if (profile.claudeConfigDir) {
      table.claude_config_dir = profile.claudeConfigDir;
    }
    profiles[name] = table;
  }
  profiles[GUEST_PROFILE_NAME] ??= {};

  const document: TomlTable = {
    codex: {
      binary: config.codex.binary,
      ...(config.codex.masqueradeAsCodexCli ? { masquerade_as_codex_cli: true } : {})
    },
    ...harnessTomlSection(config.harness),
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
      p2p_default_profile: config.permissions.p2pDefaultProfile,
      p2p_default_workspace: config.permissions.p2pDefaultWorkspace,
      group_default_profile: config.permissions.groupDefaultProfile,
      group_default_mode: config.permissions.groupDefaultMode,
      group_default_workspace: config.permissions.groupDefaultWorkspace
    },
    greeting: {
      p2p: {
        mode: config.greeting.p2p.mode,
        message: config.greeting.p2p.message
      },
      group: {
        mode: config.greeting.group.mode,
        message: config.greeting.group.message
      }
    },
    profiles
  };
  if (config.service.launchd.mode !== "gui") {
    document.service = {
      launchd: {
        mode: config.service.launchd.mode,
        ...(config.service.launchd.userName ? { user_name: config.service.launchd.userName } : {})
      }
    };
  }
  const telemetry = config.telemetry ?? normalizeTelemetryConfig(undefined);
  const hasCustomPostHogProjectToken = telemetry.posthogProjectToken !== DEFAULT_POSTHOG_PROJECT_TOKEN;
  const hasCustomPostHogHost = telemetry.posthogHost !== DEFAULT_POSTHOG_HOST;
  if (telemetry.enabled === false || hasCustomPostHogProjectToken || hasCustomPostHogHost) {
    document.telemetry = {
      enabled: telemetry.enabled
    };
    if (hasCustomPostHogProjectToken) {
      (document.telemetry as TomlTable).posthog_project_token = telemetry.posthogProjectToken;
    }
    if (hasCustomPostHogHost) {
      (document.telemetry as TomlTable).posthog_host = telemetry.posthogHost;
    }
  }
  const upgrade = config.upgrade;
  const hasCustomUpgrade =
    upgrade.channel !== DEFAULT_UPGRADE_CHANNEL ||
    upgrade.checkIntervalMs !== DEFAULT_UPGRADE_CHECK_INTERVAL_MS ||
    upgrade.autoUpdate !== DEFAULT_UPGRADE_AUTO_UPDATE ||
    !!upgrade.registry;
  if (hasCustomUpgrade) {
    document.upgrade = {
      channel: upgrade.channel,
      check_interval: formatUpgradeInterval(upgrade.checkIntervalMs),
      auto_update: upgrade.autoUpdate,
      ...(upgrade.registry ? { registry: upgrade.registry } : {})
    };
  }
  return document;
}

function harnessTomlSection(harness: HarnessConfig): { harness?: TomlTable } {
  const section: TomlTable = {};
  if (harness.default !== DEFAULT_HARNESS) {
    section.default = harness.default;
  }
  const codex: TomlTable = {};
  if (harness.codex.defaultModel) {
    codex.default_model = harness.codex.defaultModel;
  }
  if (harness.codex.defaultEffort) {
    codex.default_effort = harness.codex.defaultEffort;
  }
  if (Object.keys(codex).length > 0) {
    section.codex = codex;
  }
  const claude: TomlTable = {};
  if (harness.claude.binary !== DEFAULT_CLAUDE_BINARY) {
    claude.binary = harness.claude.binary;
  }
  if (harness.claude.defaultModel !== DEFAULT_CLAUDE_MODEL) {
    claude.default_model = harness.claude.defaultModel;
  }
  if (harness.claude.defaultEffort !== DEFAULT_CLAUDE_EFFORT) {
    claude.default_effort = harness.claude.defaultEffort;
  }
  if (Object.keys(claude).length > 0) {
    section.claude = claude;
  }
  return Object.keys(section).length > 0 ? { harness: section } : {};
}

function normalizeAuthFile(input: TwinnyAuthFileInput): TwinnyAuthFile {
  const larkAppSecret = normalizeOptionalString(input.larkAppSecret);
  return {
    larkAppId: input.larkAppId.trim(),
    ...(larkAppSecret ? { larkAppSecret } : {}),
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

function normalizeGroupDefaultMode(value: ConversationResponseMode | undefined): ConversationResponseMode {
  return isConversationResponseMode(value) ? value : NONE_PROFILE_NAME;
}

function normalizeGreetingConfig(input: {
  p2p?: Partial<GreetingTargetConfig>;
  group?: Partial<GreetingTargetConfig>;
} | undefined): GreetingConfig {
  return {
    p2p: normalizeGreetingTargetConfig(input?.p2p),
    group: normalizeGreetingTargetConfig(input?.group)
  };
}

function normalizeGreetingTargetConfig(input: Partial<GreetingTargetConfig> | undefined): GreetingTargetConfig {
  return {
    mode: normalizeGreetingMode(input?.mode),
    message: input?.message?.trim() ?? ""
  };
}

function normalizeGreetingMode(value: GreetingMode | undefined): GreetingMode {
  return value === "text" || value === "codex_turn" ? value : "none";
}

function normalizeWorkspaceTemplate(value: string | undefined): string {
  return normalizeOptionalString(value) ?? DEFAULT_CONVERSATION_WORKSPACE_TEMPLATE;
}

function validateWorkspaceTemplate(value: string, field: string): string[] {
  const issues: string[] = [];
  if (!normalizeOptionalString(value)) {
    issues.push(`${field} is required after defaults`);
    return issues;
  }
  const supportedVariables = new Set(["twinny_home", "conversation_key"]);
  for (const match of value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const variable = match[1]?.trim() ?? "";
    if (!supportedVariables.has(variable)) {
      issues.push(`${field} references unsupported variable: ${variable}`);
    }
  }
  return issues;
}

function validateGreetingTargetConfig(config: GreetingTargetConfig, field: string): string[] {
  const issues: string[] = [];
  if (!isGreetingMode(config.mode)) {
    issues.push(`${field}.mode must be none, text, or codex_turn`);
  }
  if (config.mode !== "none" && !normalizeOptionalString(config.message)) {
    issues.push(`${field}.message is required when mode is ${config.mode}`);
  }
  return issues;
}

function isConversationResponseMode(value: unknown): value is ConversationResponseMode {
  return value === "all" || value === "all_at" || value === "owner" || value === "owner_at" || value === "none";
}

function isGreetingMode(value: unknown): value is GreetingMode {
  return value === "none" || value === "text" || value === "codex_turn";
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

function normalizeServiceConfig(input: { launchd?: Partial<LaunchdServiceConfig> } | undefined): ServiceConfig {
  const mode = input?.launchd?.mode === "daemon" ? "daemon" : "gui";
  const userName = mode === "daemon" ? normalizeOptionalString(input?.launchd?.userName) : undefined;
  return {
    launchd: {
      mode,
      ...(userName ? { userName } : {})
    }
  };
}

function normalizeTelemetryConfig(input: Partial<TelemetryConfig> | undefined): TelemetryConfig {
  const posthogProjectToken = normalizeOptionalString(input?.posthogProjectToken) ?? DEFAULT_POSTHOG_PROJECT_TOKEN;
  const posthogHost = normalizeOptionalString(input?.posthogHost) ?? DEFAULT_POSTHOG_HOST;
  return {
    enabled: input?.enabled ?? true,
    posthogProjectToken,
    posthogHost
  };
}

function normalizeUpgradeConfig(input: Partial<UpgradeConfig> | undefined): UpgradeConfig {
  const registry = normalizeOptionalString(input?.registry);
  return {
    channel: input?.channel === "beta" ? "beta" : DEFAULT_UPGRADE_CHANNEL,
    checkIntervalMs: normalizeUpgradeInterval(input?.checkIntervalMs),
    autoUpdate: input?.autoUpdate ?? DEFAULT_UPGRADE_AUTO_UPDATE,
    ...(registry ? { registry } : {})
  };
}

function normalizeUpgradeInterval(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : DEFAULT_UPGRADE_CHECK_INTERVAL_MS;
}

function parseUpgradeInterval(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value;
  }
  const trimmed = value.trim().toLowerCase();
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(trimmed);
  if (!match) {
    return Number.NaN;
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier =
    unit === "d" ? 24 * 60 * 60 * 1000 :
    unit === "h" ? 60 * 60 * 1000 :
    unit === "m" ? 60 * 1000 :
    unit === "s" ? 1000 :
    1;
  return amount * multiplier;
}

function formatUpgradeInterval(value: number): string {
  if (value % (24 * 60 * 60 * 1000) === 0) {
    return `${value / (24 * 60 * 60 * 1000)}d`;
  }
  if (value % (60 * 60 * 1000) === 0) {
    return `${value / (60 * 60 * 1000)}h`;
  }
  if (value % (60 * 1000) === 0) {
    return `${value / (60 * 1000)}m`;
  }
  if (value % 1000 === 0) {
    return `${value / 1000}s`;
  }
  return `${value}ms`;
}

function validateUpgradeConfig(config: UpgradeConfig): string[] {
  const issues: string[] = [];
  if (config.channel !== "stable" && config.channel !== "beta") {
    issues.push("upgrade.channel must be stable or beta");
  }
  if (!Number.isFinite(config.checkIntervalMs) || config.checkIntervalMs <= 0) {
    issues.push("upgrade.check_interval must be a positive duration");
  }
  if (config.registry) {
    try {
      new URL(config.registry);
    } catch {
      issues.push("upgrade.registry must be a valid URL");
    }
  }
  return issues;
}

function normalizeLarkCliProfileConfig(input: LarkCliProfileConfig | undefined): LarkCliProfileConfig | undefined {
  const profileName = normalizeOptionalString(input?.profileName);
  return profileName ? { profileName } : undefined;
}

function isMessageRedactionStrategy(value: unknown): value is LarkMessageRedactionStrategy {
  return value === "mask" || value === "whitespace" || value === "none";
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
