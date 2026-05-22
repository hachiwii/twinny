import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { execa } from "execa";
import { DEFAULT_CAFFEINATE_COMMAND } from "../app/caffeinate.js";
import { formatStartupInitializationProbeDetail, runStartupInitializationProbe } from "../app/startup-probe.js";
import { readConfigStatus, resolveLarkAppSecret, SecurityCliSecretStore, type SecretStore } from "../config/index.js";
import { LarkBotDirectory, LarkOpenApiClient, TenantAccessTokenManager } from "../lark/index.js";
import { isTwinnyLockHeld, readTwinnyLockMetadata } from "../lock/index.js";
import { openRuntimeDatabase } from "../store/index.js";
import type { HealthCheck, HealthSnapshot, TwinnyConfig } from "../types.js";
import { toErrorMessage } from "../errors.js";

export async function runDoctorCommand(): Promise<void> {
  const snapshot = await runDoctorChecks();
  for (const check of snapshot.checks) {
    const marker = check.ok ? "OK" : "FAIL";
    console.log(`${marker} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  if (!snapshot.ok) {
    process.exitCode = 1;
  }
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
  const secretStore = new SecurityCliSecretStore();
  let appSecret: string | undefined;
  await checkAsync(checks, "lark app_secret", async () => {
    const secret = await resolveDoctorLarkAppSecret(config.homeIdentity.keychainAccounts.larkAppSecret, secretStore);
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
        appSecret: resolvedAppSecret
      });
      await manager.getTenantAccessToken();
      return "reachable";
    });

    await checkAsync(checks, "lark bot open_id", async () => {
      return checkLarkBotOpenId(config, resolvedAppSecret);
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
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
      appSecret
    });
    const openApiClient = options.openApiClient ?? new LarkOpenApiClient({ tokenManager });
    return new LarkBotDirectory({ openApiClient });
  })();
  const botOpenId = await botDirectory.getBotOpenId();
  if (!botOpenId) {
    throw new Error("missing bot open_id");
  }
  return botOpenId;
}

export async function resolveDoctorLarkAppSecret(
  account: string,
  secretStore: SecretStore
): Promise<{ value: string; detail: "present" }> {
  const value = await resolveLarkAppSecret(account, secretStore);
  if (!value) {
    throw new Error(`missing keychain:${account}`);
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
