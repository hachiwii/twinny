import { execa, type Options as ExecaOptions } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import { TwinnyError } from "../errors.js";
import type { RuntimePaths } from "../types.js";
import { createRuntimePaths } from "./paths.js";

export const TWINNY_KEYCHAIN_SERVICE = "twinny";

export const SECRET_ACCOUNTS = {
  larkAppSecret: "lark.app_secret"
} as const;

export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
  has(account: string): Promise<boolean>;
}

export interface SecurityCliSecretStoreOptions {
  service?: string;
  execaOptions?: ExecaOptions;
}

export interface FileSecretStoreOptions {
  filePath: string;
}

export interface DefaultSecretStoreOptions {
  platform?: NodeJS.Platform;
  paths?: Pick<RuntimePaths, "secretsFile">;
  filePath?: string;
}

export class SecurityCliSecretStore implements SecretStore {
  readonly service: string;
  private readonly execaOptions?: ExecaOptions;

  constructor(options: SecurityCliSecretStoreOptions = {}) {
    this.service = options.service ?? TWINNY_KEYCHAIN_SERVICE;
    this.execaOptions = options.execaOptions;
  }

  async get(account: string): Promise<string | null> {
    try {
      const result = await execa(
        "security",
        ["find-generic-password", "-s", this.service, "-a", account, "-w"],
        this.execaOptions
      );
      return typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "");
    } catch (error) {
      if (isSecurityNotFound(error)) {
        return null;
      }
      throw new TwinnyError(`failed to read secret ${account} from macOS Keychain`, "KEYCHAIN_READ_FAILED", error);
    }
  }

  async set(account: string, value: string): Promise<void> {
    try {
      await execa(
        "security",
        ["add-generic-password", "-U", "-s", this.service, "-a", account, "-w", value],
        this.execaOptions
      );
    } catch (error) {
      throw new TwinnyError(`failed to write secret ${account} to macOS Keychain`, "KEYCHAIN_WRITE_FAILED", error);
    }
  }

  async delete(account: string): Promise<void> {
    try {
      await execa(
        "security",
        ["delete-generic-password", "-s", this.service, "-a", account],
        this.execaOptions
      );
    } catch (error) {
      if (isSecurityNotFound(error)) {
        return;
      }
      throw new TwinnyError(`failed to delete secret ${account} from macOS Keychain`, "KEYCHAIN_DELETE_FAILED", error);
    }
  }

  async has(account: string): Promise<boolean> {
    return (await this.get(account)) !== null;
  }
}

export class FileSecretStore implements SecretStore {
  readonly filePath: string;

  constructor(options: FileSecretStoreOptions) {
    this.filePath = path.resolve(options.filePath);
  }

  async get(account: string): Promise<string | null> {
    const secrets = await this.readSecrets();
    return secrets[account] ?? null;
  }

  async set(account: string, value: string): Promise<void> {
    const secrets = await this.readSecrets();
    secrets[account] = value;
    await this.writeSecrets(secrets);
  }

  async delete(account: string): Promise<void> {
    const secrets = await this.readSecrets();
    delete secrets[account];
    await this.writeSecrets(secrets);
  }

  async has(account: string): Promise<boolean> {
    return (await this.get(account)) !== null;
  }

  private async readSecrets(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return {};
      }
      throw new TwinnyError(`failed to read secret file ${this.filePath}`, "SECRET_FILE_READ_FAILED", error);
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("secret file root must be an object");
      }
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof key === "string" && typeof value === "string") {
          result[key] = value;
        }
      }
      return result;
    } catch (error) {
      throw new TwinnyError(`failed to parse secret file ${this.filePath}`, "SECRET_FILE_PARSE_FAILED", error);
    }
  }

  private async writeSecrets(secrets: Record<string, string>): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      throw new TwinnyError(`failed to write secret file ${this.filePath}`, "SECRET_FILE_WRITE_FAILED", error);
    }
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  async get(account: string): Promise<string | null> {
    return this.secrets.get(account) ?? null;
  }

  async set(account: string, value: string): Promise<void> {
    this.secrets.set(account, value);
  }

  async delete(account: string): Promise<void> {
    this.secrets.delete(account);
  }

  async has(account: string): Promise<boolean> {
    return this.secrets.has(account);
  }
}

export function createDefaultSecretStore(options: DefaultSecretStoreOptions = {}): SecretStore {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return new SecurityCliSecretStore();
  }
  return new FileSecretStore({
    filePath: options.filePath ?? options.paths?.secretsFile ?? createRuntimePaths().secretsFile
  });
}

export function larkAppSecretAccountForHomeRandom(homeRandom: string): string {
  const normalized = homeRandom.trim().toLowerCase();
  if (!/^[0-9a-f]{32,64}$/.test(normalized)) {
    throw new TwinnyError("invalid Twinny home random value", "TWINNY_HOME_RANDOM_INVALID");
  }
  return `twinny.home.${normalized}.lark.app_secret`;
}

export async function resolveLarkAppSecret(
  account: string,
  secretStore: SecretStore,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (env.TWINNY_LARK_APP_SECRET) {
    return env.TWINNY_LARK_APP_SECRET;
  }
  return secretStore.get(account);
}

function isSecurityNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { exitCode?: number; stderr?: string; stdout?: string; message?: string };
  const text = `${candidate.stderr ?? ""}\n${candidate.stdout ?? ""}\n${candidate.message ?? ""}`.toLowerCase();
  return candidate.exitCode === 44 || text.includes("could not be found") || text.includes("item could not be found");
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
