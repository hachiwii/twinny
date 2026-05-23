import { TwinnyError } from "../errors.js";
import type { LarkBrand } from "../types.js";
import type { FetchLike, LarkCredentialOptions } from "./types.js";

export const DEFAULT_LARK_OPENAPI_BASE_URL = "https://open.feishu.cn/open-apis";
export const DEFAULT_LARK_ACCOUNTS_BASE_URL = "https://accounts.feishu.cn";
export const DEFAULT_LARK_OPEN_BASE_URL = "https://open.feishu.cn";
export const DEFAULT_LARKSUITE_OPEN_BASE_URL = "https://open.larksuite.com";
export const DEFAULT_LARKSUITE_OPENAPI_BASE_URL = "https://open.larksuite.com/open-apis";
export const DEFAULT_LARKSUITE_ACCOUNTS_BASE_URL = "https://accounts.larksuite.com";
const DEFAULT_TENANT_TOKEN_EXPIRE_SECONDS = 7200;
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface LarkEndpointSet {
  open: string;
  openApi: string;
  accounts: string;
}

export interface TenantAccessTokenManagerOptions extends LarkCredentialOptions {
  refreshSkewMs?: number;
}

export interface TenantAccessTokenSnapshot {
  token: string;
  expiresAtMs: number;
}

export class TenantAccessTokenManager {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private cachedToken?: TenantAccessTokenSnapshot;
  private inFlight?: Promise<string>;

  constructor(options: TenantAccessTokenManagerOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_LARK_OPENAPI_BASE_URL);
    this.fetch = options.fetch ?? globalFetch;
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  get snapshot(): TenantAccessTokenSnapshot | undefined {
    return this.cachedToken;
  }

  clear(): void {
    this.cachedToken = undefined;
    this.inFlight = undefined;
  }

  async getTenantAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    if (!options.forceRefresh && this.cachedToken && this.isUsable(this.cachedToken)) {
      return this.cachedToken.token;
    }

    if (!options.forceRefresh && this.inFlight) {
      return this.inFlight;
    }

    const refresh = this.fetchTenantAccessToken().finally(() => {
      if (this.inFlight === refresh) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = refresh;
    return refresh;
  }

  private isUsable(token: TenantAccessTokenSnapshot): boolean {
    return this.now() + this.refreshSkewMs < token.expiresAtMs;
  }

  private async fetchTenantAccessToken(): Promise<string> {
    const response = await this.fetch(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret
      })
    });

    const body = await readJsonBody(response);
    const record = toRecord(body);
    const code = Number(record.code ?? 0);
    if (!response.ok || code !== 0) {
      throw new TwinnyError(
        `failed to get Lark tenant access token: ${formatOpenApiFailure(response, record)}`,
        "LARK_TENANT_TOKEN_FAILED"
      );
    }

    const token = record.tenant_access_token;
    if (typeof token !== "string" || token.length === 0) {
      throw new TwinnyError("Lark tenant access token response did not include tenant_access_token", "LARK_TENANT_TOKEN_MISSING");
    }

    const expireSeconds =
      typeof record.expire === "number" && Number.isFinite(record.expire)
        ? record.expire
        : DEFAULT_TENANT_TOKEN_EXPIRE_SECONDS;
    this.cachedToken = {
      token,
      expiresAtMs: this.now() + Math.max(0, expireSeconds) * 1000
    };
    return token;
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function normalizeLarkBrand(value: string | undefined): LarkBrand {
  return value === "lark" ? "lark" : "feishu";
}

export function resolveLarkEndpoints(brand: LarkBrand = "feishu"): LarkEndpointSet {
  if (brand === "lark") {
    return {
      open: DEFAULT_LARKSUITE_OPEN_BASE_URL,
      openApi: DEFAULT_LARKSUITE_OPENAPI_BASE_URL,
      accounts: DEFAULT_LARKSUITE_ACCOUNTS_BASE_URL
    };
  }
  return {
    open: DEFAULT_LARK_OPEN_BASE_URL,
    openApi: DEFAULT_LARK_OPENAPI_BASE_URL,
    accounts: DEFAULT_LARK_ACCOUNTS_BASE_URL
  };
}

async function readJsonBody(response: { json(): Promise<unknown>; text?: () => Promise<string> }): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (response.text) {
      try {
        return { raw: await response.text() };
      } catch {
        // Fall through to the original JSON parse error.
      }
    }
    throw error;
  }
}

function formatOpenApiFailure(response: { status: number; statusText: string }, body: Record<string, unknown>): string {
  const msg = typeof body.msg === "string" && body.msg.length > 0 ? body.msg : response.statusText;
  return `status=${response.status} code=${String(body.code ?? "unknown")} msg=${msg}`;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const globalFetch: FetchLike = async (input, init) => {
  if (typeof fetch !== "function") {
    throw new TwinnyError("global fetch is not available in this Node.js runtime", "LARK_FETCH_UNAVAILABLE");
  }
  return fetch(input, init);
};
