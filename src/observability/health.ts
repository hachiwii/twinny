import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { execa } from "execa";
import { DEFAULT_CAFFEINATE_COMMAND } from "../app/caffeinate.js";
import { formatStartupInitializationProbeDetail, runStartupInitializationProbe } from "../app/startup-probe.js";
import { createDefaultSecretStore, readConfigStatus, resolveLarkAppSecret, type SecretStore } from "../config/index.js";
import {
  LarkFeatureConfigurationChecker,
  LARK_REQUIRED_SCOPES,
  LARK_REQUIRED_SCOPE_ALTERNATIVES,
  LarkBotDirectory,
  LarkOpenApiClient,
  resolveLarkEndpoints,
  summarizeLarkFeatureCheckIssue,
  TenantAccessTokenManager,
  type LarkFeatureCheckResult
} from "../lark/index.js";
import { isTwinnyLockHeld, readTwinnyLockMetadata } from "../lock/index.js";
import { openRuntimeDatabase } from "../store/index.js";
import type { HealthCheck, HealthSnapshot, TwinnyConfig } from "../types.js";
import { toErrorMessage } from "../errors.js";

export async function runDoctorCommand(): Promise<void> {
  const snapshot = await runDoctorChecks();
  for (const check of snapshot.checks) {
    console.log(formatDoctorCheckLine(check));
  }
  if (!snapshot.ok) {
    process.exitCode = 1;
  }
}

export function formatDoctorCheckLine(check: HealthCheck): string {
  const marker = check.skipped ? "SKIP" : check.ok ? "OK" : "FAIL";
  return `${marker} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`;
}

export async function runDoctorChecks(): Promise<HealthSnapshot> {
  const checks: HealthCheck[] = [];
  const configStatus = await readConfigStatus();
  checks.push({
    name: "config",
    ok: configStatus.complete,
    detail: configStatus.complete ? configStatus.paths.configFile : configStatus.issues.join("; ")
  });

  if (!configStatus.config) {
    return { ok: false, checks };
  }

  const config = configStatus.config;
  const secretStore = createDefaultSecretStore({ paths: configStatus.paths });
  let appSecret: string | undefined;
  await checkAsync(checks, "lark app_secret", async () => {
    const secret = await resolveDoctorLarkAppSecret(config.homeIdentity.keychainAccounts.larkAppSecret, secretStore, config.auth.larkAppSecret);
    appSecret = secret.value;
    return secret.detail;
  });

  await checkAsync(checks, "codex binary", async () => {
    const result = await execa(config.codex.binary, ["--version"], { reject: false });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `exit ${result.exitCode}`);
    }
    return result.stdout.trim();
  });

  await checkAsync(checks, "caffeinate binary", async () => {
    return checkCaffeinateBinary();
  });

  await checkAsync(checks, "sqlite", async () => {
    const db = openRuntimeDatabase(configStatus.paths);
    db.close();
    return configStatus.paths.sqliteFile;
  });

  await checkAsync(checks, "startup initialization", async () => {
    return formatStartupInitializationProbeDetail(
      await runStartupInitializationProbe({
        config,
        paths: configStatus.paths
      })
    );
  });

  await checkAsync(checks, "singleton lock", async () => {
    const held = await isTwinnyLockHeld(configStatus.paths);
    if (!held) {
      return "not running";
    }
    const metadata = await readTwinnyLockMetadata(configStatus.paths);
    return metadata ? `held by pid ${metadata.pid}` : "held";
  });

  const resolvedAppSecret = appSecret;
  if (resolvedAppSecret) {
    await checkAsync(checks, "lark tenant token", async () => {
      const manager = new TenantAccessTokenManager({
        appId: config.auth.larkAppId,
        appSecret: resolvedAppSecret,
        baseUrl: resolveLarkEndpoints(config.auth.larkBrand).openApi
      });
      await manager.getTenantAccessToken();
      return "reachable";
    });

    await checkAsync(checks, "lark bot open_id", async () => {
      return checkLarkBotOpenId(config, resolvedAppSecret);
    });

    await checkLarkNecessaryConfiguration(checks, config, resolvedAppSecret);
  }

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
}

export async function checkLarkNecessaryFeatureConfiguration(
  config: Pick<TwinnyConfig, "auth">,
  appSecret: string,
  options: {
    tokenManager?: TenantAccessTokenManager;
    openApiClient?: Pick<LarkOpenApiClient, "request">;
  } = {}
): Promise<LarkFeatureCheckResult> {
  const openApiClient = options.openApiClient ?? (() => {
    const tokenManager = options.tokenManager ?? new TenantAccessTokenManager({
      appId: config.auth.larkAppId,
      appSecret,
      baseUrl: resolveLarkEndpoints(config.auth.larkBrand).openApi
    });
    return new LarkOpenApiClient({
      tokenManager,
      baseUrl: resolveLarkEndpoints(config.auth.larkBrand).openApi
    });
  })();
  return new LarkFeatureConfigurationChecker({
    appId: config.auth.larkAppId,
    openApiClient
  }).checkFeatureSet("necessary");
}

export async function checkCaffeinateBinary(options: {
  command?: string;
  platform?: NodeJS.Platform;
  access?: typeof fs.access;
} = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return `not required on ${platform}`;
  }
  const command = options.command ?? DEFAULT_CAFFEINATE_COMMAND;
  await (options.access ?? fs.access)(command, fsConstants.X_OK);
  return command;
}

export async function checkLarkBotOpenId(
  config: Pick<TwinnyConfig, "auth">,
  appSecret: string,
  options: {
    tokenManager?: TenantAccessTokenManager;
    openApiClient?: LarkOpenApiClient;
    botDirectory?: Pick<LarkBotDirectory, "getBotOpenId">;
  } = {}
): Promise<string> {
  const botDirectory = options.botDirectory ?? (() => {
    const tokenManager = options.tokenManager ?? new TenantAccessTokenManager({
      appId: config.auth.larkAppId,
      appSecret,
      baseUrl: resolveLarkEndpoints(config.auth.larkBrand).openApi
    });
    const openApiClient = options.openApiClient ?? new LarkOpenApiClient({
      tokenManager,
      baseUrl: resolveLarkEndpoints(config.auth.larkBrand).openApi
    });
    return new LarkBotDirectory({ openApiClient });
  })();
  const botOpenId = await botDirectory.getBotOpenId();
  if (!botOpenId) {
    throw new Error("missing bot open_id");
  }
  return botOpenId;
}

export async function checkLarkRequiredScopes(
  config: Pick<TwinnyConfig, "auth">,
  appSecret: string,
  options: {
    tokenManager?: TenantAccessTokenManager;
    openApiClient?: Pick<LarkOpenApiClient, "request">;
    requiredScopes?: readonly string[];
  } = {}
): Promise<string> {
  const openApiClient = options.openApiClient ?? (() => {
    const tokenManager = options.tokenManager ?? new TenantAccessTokenManager({
      appId: config.auth.larkAppId,
      appSecret,
      baseUrl: resolveLarkEndpoints(config.auth.larkBrand).openApi
    });
    return new LarkOpenApiClient({
      tokenManager,
      baseUrl: resolveLarkEndpoints(config.auth.larkBrand).openApi
    });
  })();
  const requiredScopes = options.requiredScopes ?? LARK_REQUIRED_SCOPES;
  const grantedScopes = await getGrantedLarkScopes(openApiClient);
  const missingScopes = requiredScopes.filter((scope) => !hasGrantedLarkScope(scope, grantedScopes));
  if (missingScopes.length > 0) {
    throw new Error(`missing: ${missingScopes.join(", ")}`);
  }
  return `${requiredScopes.length} required scopes granted`;
}

export async function resolveDoctorLarkAppSecret(
  account: string,
  secretStore: SecretStore,
  authAppSecret?: string
): Promise<{ value: string; detail: "present" }> {
  const value = await resolveLarkAppSecret(account, secretStore, process.env, authAppSecret);
  if (!value) {
    throw new Error(`missing auth.json lark_app_secret or keychain:${account}`);
  }
  return {
    value,
    detail: "present"
  };
}

async function checkAsync<T>(
  checks: HealthCheck[],
  name: string,
  run: () => Promise<T>
): Promise<T | undefined> {
  try {
    const result = await run();
    checks.push({
      name,
      ok: true,
      detail: typeof result === "string" ? result : undefined
    });
    return result;
  } catch (error) {
    checks.push({
      name,
      ok: false,
      detail: toErrorMessage(error)
    });
    return undefined;
  }
}

async function checkLarkNecessaryConfiguration(
  checks: HealthCheck[],
  config: Pick<TwinnyConfig, "auth">,
  appSecret: string
): Promise<void> {
  const result = await checkLarkNecessaryFeatureConfiguration(config, appSecret);
  if (result.skipped) {
    checks.push({
      name: "lark necessary configuration",
      ok: true,
      skipped: true,
      detail: result.skipReason
    });
    return;
  }
  if (!result.ok) {
    checks.push({
      name: "lark necessary configuration",
      ok: false,
      detail: summarizeLarkFeatureCheckIssue(result)
    });
    return;
  }
  checks.push({
    name: "lark necessary configuration",
    ok: true,
    detail: summarizeLarkFeatureCheckIssue(result)
  });
}

async function getGrantedLarkScopes(openApiClient: Pick<LarkOpenApiClient, "request">): Promise<Set<string>> {
  const raw = await openApiClient.request("/application/v6/scopes", { method: "GET" });
  const scopes = asRecord(asRecord(raw).data).scopes;
  if (!Array.isArray(scopes)) {
    throw new Error("invalid Lark scope response");
  }
  const granted = new Set<string>();
  for (const item of scopes) {
    const scope = asRecord(item);
    if (typeof scope.scope_name === "string" && scope.grant_status === 1) {
      granted.add(scope.scope_name);
    }
  }
  return granted;
}

function hasGrantedLarkScope(scope: string, grantedScopes: Set<string>): boolean {
  return grantedScopes.has(scope) || (LARK_REQUIRED_SCOPE_ALTERNATIVES[scope]?.some((alternative) => grantedScopes.has(alternative)) ?? false);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
