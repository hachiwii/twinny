import { execa } from "execa";
import { readConfigStatus, resolveSecretRef, SecurityCliSecretStore } from "../config/index.js";
import { TenantAccessTokenManager } from "../lark/index.js";
import { isTwinnyLockHeld, readTwinnyLockMetadata } from "../lock/index.js";
import { openRuntimeDatabase } from "../store/index.js";
import type { HealthCheck, HealthSnapshot } from "../types.js";
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
  const appSecret = await checkAsync(checks, "lark app_secret", async () => {
    const secret = await resolveSecretRef(config.lark.appSecretRef, secretStore);
    if (!secret) {
      throw new Error(`missing ${config.lark.appSecretRef}`);
    }
    return secret;
  });

  await checkAsync(checks, "owner user token", async () => {
    if (!config.owner.tokenRef) {
      throw new Error("owner.token_ref missing");
    }
    const token = await resolveSecretRef(config.owner.tokenRef, secretStore);
    if (!token) {
      throw new Error(`missing ${config.owner.tokenRef}`);
    }
  });

  if (config.autoApproval.enabled) {
    await checkAsync(checks, "auto approval config", async () => {
      if (!config.autoApproval.definitionCode) {
        throw new Error("auto_approval.definition_code missing");
      }
      if (!config.owner.refreshTokenRef) {
        throw new Error("owner.refresh_token_ref missing");
      }
      const refreshToken = await resolveSecretRef(config.owner.refreshTokenRef, secretStore);
      if (!refreshToken) {
        throw new Error(`missing ${config.owner.refreshTokenRef}`);
      }
      return `poll ${config.autoApproval.pollIntervalMs}ms`;
    });
  }

  await checkAsync(checks, "codex binary", async () => {
    const result = await execa(config.codex.binary, ["--version"], { reject: false });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `exit ${result.exitCode}`);
    }
    return result.stdout.trim();
  });

  await checkAsync(checks, "sqlite", async () => {
    const db = openRuntimeDatabase(configStatus.paths);
    db.close();
    return configStatus.paths.sqliteFile;
  });

  await checkAsync(checks, "singleton lock", async () => {
    const held = await isTwinnyLockHeld(configStatus.paths);
    if (!held) {
      return "not running";
    }
    const metadata = await readTwinnyLockMetadata(configStatus.paths);
    return metadata ? `held by pid ${metadata.pid}` : "held";
  });

  if (appSecret) {
    await checkAsync(checks, "lark tenant token", async () => {
      const manager = new TenantAccessTokenManager({
        appId: config.lark.appId,
        appSecret
      });
      await manager.getTenantAccessToken();
      return "reachable";
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks
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
