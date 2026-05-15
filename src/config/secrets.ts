import { execa, type Options as ExecaOptions } from "execa";
import { TwinnyError } from "../errors.js";

export const TWINNY_KEYCHAIN_SERVICE = "twinny";

export const SECRET_ACCOUNTS = {
  larkAppSecret: "lark.app_secret",
  ownerUserToken: "lark.owner.user_token",
  ownerRefreshToken: "lark.owner.refresh_token"
} as const;

export const SECRET_REFS = {
  larkAppSecret: "keychain:twinny/lark/app_secret",
  ownerUserToken: "keychain:twinny/lark/owner_user_token",
  ownerRefreshToken: "keychain:twinny/lark/owner_refresh_token"
} as const;

const REF_TO_ACCOUNT = new Map<string, string>([
  [SECRET_REFS.larkAppSecret, SECRET_ACCOUNTS.larkAppSecret],
  [SECRET_REFS.ownerUserToken, SECRET_ACCOUNTS.ownerUserToken],
  [SECRET_REFS.ownerRefreshToken, SECRET_ACCOUNTS.ownerRefreshToken]
]);

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

export function secretAccountFromRef(ref: string): string {
  const known = REF_TO_ACCOUNT.get(ref);
  if (known) {
    return known;
  }

  const prefix = `keychain:${TWINNY_KEYCHAIN_SERVICE}/`;
  if (!ref.startsWith(prefix)) {
    throw new TwinnyError(`unsupported secret reference: ${ref}`, "UNSUPPORTED_SECRET_REF");
  }
  return ref.slice(prefix.length).replaceAll("/", ".");
}

export async function resolveSecretRef(
  ref: string,
  secretStore: SecretStore,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (ref === SECRET_REFS.larkAppSecret && env.TWINNY_LARK_APP_SECRET) {
    return env.TWINNY_LARK_APP_SECRET;
  }
  return secretStore.get(secretAccountFromRef(ref));
}

function isSecurityNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { exitCode?: number; stderr?: string; stdout?: string; message?: string };
  const text = `${candidate.stderr ?? ""}\n${candidate.stdout ?? ""}\n${candidate.message ?? ""}`.toLowerCase();
  return candidate.exitCode === 44 || text.includes("could not be found") || text.includes("item could not be found");
}
