import { TwinnyError } from "../errors.js";
import type { FetchLike, LarkCredentialOptions } from "./types.js";

export const DEFAULT_LARK_OPENAPI_BASE_URL = "https://open.feishu.cn/open-apis";
export const DEFAULT_LARK_ACCOUNTS_BASE_URL = "https://accounts.feishu.cn";
const DEFAULT_TENANT_TOKEN_EXPIRE_SECONDS = 7200;
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_AUTH_EXPIRE_SECONDS = 240;
const DEFAULT_DEVICE_AUTH_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_USER_TOKEN_EXPIRE_SECONDS = 7200;
const DEFAULT_REFRESH_TOKEN_EXPIRE_SECONDS = 604800;

export interface TenantAccessTokenManagerOptions extends LarkCredentialOptions {
  refreshSkewMs?: number;
}

export interface UserAccessTokenManagerOptions extends LarkCredentialOptions {
  accessToken?: string;
  refreshToken?: string;
  refreshSkewMs?: number;
  onTokenRefresh?: (token: UserAccessTokenResult) => Promise<void> | void;
}

export interface TenantAccessTokenSnapshot {
  token: string;
  expiresAtMs: number;
}

export interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenPollingOptions {
  deviceCode: string;
  expiresIn?: number;
  interval?: number;
  signal?: AbortSignal;
}

export interface UserAccessTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
  scope: string;
}

export interface LarkAuthenticatedUser {
  openId: string;
  displayName: string;
  userId?: string;
  unionId?: string;
}

export interface LarkUserOAuthDeviceFlowOptions extends LarkCredentialOptions {
  accountsBaseUrl?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxPollAttempts?: number;
}

export interface AuthorizeUserResult {
  authorization: DeviceAuthorizationResponse;
  token: UserAccessTokenResult;
  user: LarkAuthenticatedUser;
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

export class UserAccessTokenManager {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private readonly onTokenRefresh?: (token: UserAccessTokenResult) => Promise<void> | void;
  private cachedToken?: TenantAccessTokenSnapshot;
  private refreshToken?: string;
  private inFlight?: Promise<string>;

  constructor(options: UserAccessTokenManagerOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_LARK_OPENAPI_BASE_URL);
    this.fetch = options.fetch ?? globalFetch;
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.onTokenRefresh = options.onTokenRefresh;
    this.refreshToken = normalizeOptionalString(options.refreshToken);
    if (options.accessToken) {
      this.cachedToken = {
        token: options.accessToken,
        expiresAtMs: this.refreshToken ? 0 : Number.POSITIVE_INFINITY
      };
    }
  }

  get snapshot(): TenantAccessTokenSnapshot | undefined {
    return this.cachedToken;
  }

  clear(): void {
    this.cachedToken = undefined;
    this.inFlight = undefined;
  }

  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    if (!options.forceRefresh && this.cachedToken && this.isUsable(this.cachedToken)) {
      return this.cachedToken.token;
    }

    if (!this.refreshToken) {
      if (!options.forceRefresh && this.cachedToken) {
        return this.cachedToken.token;
      }
      throw new TwinnyError("Lark owner refresh token is missing; rerun owner authorization with approval scopes", "LARK_OWNER_REFRESH_TOKEN_MISSING");
    }

    if (!options.forceRefresh && this.inFlight) {
      return this.inFlight;
    }

    const refresh = this.refreshUserAccessToken().finally(() => {
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

  private async refreshUserAccessToken(): Promise<string> {
    const response = await this.fetch(`${this.baseUrl}/authen/v2/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: this.appId,
        client_secret: this.appSecret,
        refresh_token: this.refreshToken
      })
    });

    const record = toRecord(await readJsonBody(response));
    const code = Number(record.code ?? 0);
    if (!response.ok || code !== 0 || stringField(record, "error")) {
      throw new TwinnyError(
        `failed to refresh Lark owner user token: ${oauthErrorMessage(record) || formatOpenApiFailure(response, record)}`,
        "LARK_OWNER_TOKEN_REFRESH_FAILED"
      );
    }

    const accessToken = requireStringField(record, "access_token", "LARK_OWNER_TOKEN_REFRESH_MISSING_ACCESS_TOKEN");
    const refreshToken = stringField(record, "refresh_token") || undefined;
    const token: UserAccessTokenResult = {
      accessToken,
      refreshToken,
      expiresIn: numberField(record, "expires_in", DEFAULT_USER_TOKEN_EXPIRE_SECONDS),
      refreshTokenExpiresIn: numberField(
        record,
        "refresh_token_expires_in",
        refreshToken ? DEFAULT_REFRESH_TOKEN_EXPIRE_SECONDS : DEFAULT_USER_TOKEN_EXPIRE_SECONDS
      ),
      scope: stringField(record, "scope")
    };

    this.cachedToken = {
      token: token.accessToken,
      expiresAtMs: this.now() + Math.max(0, token.expiresIn) * 1000
    };
    if (token.refreshToken) {
      this.refreshToken = token.refreshToken;
    }
    await this.onTokenRefresh?.(token);
    return token.accessToken;
  }
}

export class LarkUserOAuthDeviceFlow {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly openApiBaseUrl: string;
  private readonly accountsBaseUrl: string;
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxPollAttempts: number;

  constructor(options: LarkUserOAuthDeviceFlowOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.openApiBaseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_LARK_OPENAPI_BASE_URL);
    this.accountsBaseUrl = normalizeBaseUrl(options.accountsBaseUrl ?? DEFAULT_LARK_ACCOUNTS_BASE_URL);
    this.fetch = options.fetch ?? globalFetch;
    this.sleep = options.sleep ?? sleep;
    this.maxPollAttempts = options.maxPollAttempts ?? 600;
  }

  async requestDeviceAuthorization(scope = "offline_access"): Promise<DeviceAuthorizationResponse> {
    const normalizedScope = ensureOfflineAccess(normalizeScope(scope));
    const body = new URLSearchParams({
      client_id: this.appId,
      scope: normalizedScope
    }).toString();
    const response = await this.fetch(`${this.accountsBaseUrl}/oauth/v1/device_authorization`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.appId}:${this.appSecret}`, "utf8").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    const record = toRecord(await readJsonBody(response));
    const errorMessage = oauthErrorMessage(record);
    if (!response.ok || errorMessage) {
      throw new TwinnyError(
        `failed to start Lark device authorization: ${errorMessage || formatOpenApiFailure(response, record)}`,
        "LARK_DEVICE_AUTH_FAILED"
      );
    }

    const verificationUri = stringField(record, "verification_uri");
    return {
      deviceCode: requireStringField(record, "device_code", "LARK_DEVICE_AUTH_MISSING_DEVICE_CODE"),
      userCode: stringField(record, "user_code"),
      verificationUri,
      verificationUriComplete: stringField(record, "verification_uri_complete") || verificationUri,
      expiresIn: numberField(record, "expires_in", DEFAULT_DEVICE_AUTH_EXPIRE_SECONDS),
      interval: numberField(record, "interval", DEFAULT_DEVICE_AUTH_POLL_INTERVAL_SECONDS)
    };
  }

  async pollDeviceToken(options: DeviceTokenPollingOptions): Promise<UserAccessTokenResult> {
    const expiresIn = options.expiresIn ?? DEFAULT_DEVICE_AUTH_EXPIRE_SECONDS;
    let interval = Math.max(1, options.interval ?? DEFAULT_DEVICE_AUTH_POLL_INTERVAL_SECONDS);
    const startedAt = Date.now();
    let attempts = 0;

    while (Date.now() - startedAt < expiresIn * 1000 && attempts < this.maxPollAttempts) {
      attempts += 1;
      await this.sleep(interval * 1000, options.signal);

      const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: options.deviceCode,
        client_id: this.appId,
        client_secret: this.appSecret
      }).toString();
      const response = await this.fetch(`${this.openApiBaseUrl}/authen/v2/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded"
        },
        body,
        signal: options.signal
      });
      const record = toRecord(await readJsonBody(response));
      const error = stringField(record, "error");

      if (!error && stringField(record, "access_token")) {
        const accessToken = stringField(record, "access_token");
        const refreshToken = stringField(record, "refresh_token") || undefined;
        return {
          accessToken,
          refreshToken,
          expiresIn: numberField(record, "expires_in", DEFAULT_USER_TOKEN_EXPIRE_SECONDS),
          refreshTokenExpiresIn: numberField(
            record,
            "refresh_token_expires_in",
            refreshToken ? DEFAULT_REFRESH_TOKEN_EXPIRE_SECONDS : DEFAULT_USER_TOKEN_EXPIRE_SECONDS
          ),
          scope: stringField(record, "scope")
        };
      }

      if (error === "authorization_pending") {
        continue;
      }
      if (error === "slow_down") {
        interval = Math.min(interval + 5, 60);
        continue;
      }

      throw new TwinnyError(
        `Lark device authorization did not complete: ${oauthErrorMessage(record) || formatOpenApiFailure(response, record)}`,
        "LARK_DEVICE_TOKEN_FAILED"
      );
    }

    throw new TwinnyError("Lark device authorization timed out before the user completed login", "LARK_DEVICE_AUTH_TIMEOUT");
  }

  async getUserInfo(accessToken: string): Promise<LarkAuthenticatedUser> {
    const response = await this.fetch(`${this.openApiBaseUrl}/authen/v1/user_info`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });
    const record = toRecord(await readJsonBody(response));
    const code = Number(record.code ?? 0);
    if (!response.ok || code !== 0) {
      throw new TwinnyError(
        `failed to get Lark user info: ${formatOpenApiFailure(response, record)}`,
        "LARK_USER_INFO_FAILED"
      );
    }

    const data = toRecord(record.data);
    const openId = requireStringField(data, "open_id", "LARK_USER_INFO_MISSING_OPEN_ID");
    return {
      openId,
      displayName: stringField(data, "name") || "(unknown)",
      userId: stringField(data, "user_id") || undefined,
      unionId: stringField(data, "union_id") || undefined
    };
  }

  async authorizeUser(scope = "offline_access", onAuthorization?: (authorization: DeviceAuthorizationResponse) => void): Promise<AuthorizeUserResult> {
    const authorization = await this.requestDeviceAuthorization(scope);
    onAuthorization?.(authorization);
    const token = await this.pollDeviceToken(authorization);
    const user = await this.getUserInfo(token.accessToken);
    return { authorization, token, user };
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
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

function normalizeScope(scope: string): string {
  return scope
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
}

function ensureOfflineAccess(scope: string): string {
  const scopes = new Set(scope.split(/\s+/).filter(Boolean));
  scopes.add("offline_access");
  return [...scopes].sort().join(" ");
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function requireStringField(record: Record<string, unknown>, key: string, code: string): string {
  const value = stringField(record, key);
  if (!value) {
    throw new TwinnyError(`Lark response did not include ${key}`, code);
  }
  return value;
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function oauthErrorMessage(record: Record<string, unknown>): string {
  return stringField(record, "error_description") || stringField(record, "error");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("The operation was aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

const globalFetch: FetchLike = async (input, init) => {
  if (typeof fetch !== "function") {
    throw new TwinnyError("global fetch is not available in this Node.js runtime", "LARK_FETCH_UNAVAILABLE");
  }
  return fetch(input, init);
};
