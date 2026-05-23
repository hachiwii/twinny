import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";
import { TwinnyError } from "../errors.js";
import type { LarkBrand } from "../types.js";
import { resolveLarkEndpoints } from "./auth.js";
import type { FetchLike } from "./types.js";

export const LARK_APP_REGISTRATION_PATH = "/oauth/v1/app/registration";
export const LARK_DEVICE_AUTHORIZATION_PATH = "/oauth/v1/device_authorization";
export const LARK_OAUTH_TOKEN_PATH = "/authen/v2/oauth/token";
export const LARK_USER_INFO_PATH = "/authen/v1/user_info";

const deviceCodeGrantType = "urn:ietf:params:oauth:grant-type:device_code";
const maxPollIntervalSeconds = 60;
const maxAppRegistrationPollAttempts = 200;
const maxDeviceTokenPollAttempts = 600;

export interface LarkAppRegistrationBeginResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface LarkAppRegistrationResult {
  appId: string;
  appSecret: string;
  brand: LarkBrand;
  ownerOpenId?: string;
}

export interface LarkDeviceAuthorizationResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface LarkDeviceTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  refreshExpiresIn: number;
  scope?: string;
}

export interface LarkBrowserUserInfo {
  openId: string;
  name: string;
}

export interface LarkBrowserAuthOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  now?: () => number;
}

interface AppRegistrationPollRawResult {
  clientId: string;
  clientSecret: string;
  tenantBrand?: string;
  openId?: string;
}

export async function requestLarkAppRegistration(
  brand: LarkBrand,
  options: LarkBrowserAuthOptions = {}
): Promise<LarkAppRegistrationBeginResult> {
  const fetch = options.fetch ?? globalFetch;
  const displayEndpoints = resolveLarkEndpoints(brand);
  const registrationEndpoints = resolveLarkEndpoints("feishu");
  const body = new URLSearchParams({
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id tenant_brand"
  });
  const response = await fetch(`${registrationEndpoints.accounts}${LARK_APP_REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: options.signal
  });
  const payload = await readJsonBody(response);
  if (!response.ok || stringField(payload, "error")) {
    throw new TwinnyError(`app registration failed: ${errorDescription(payload, response.statusText)}`, "LARK_APP_REGISTRATION_FAILED");
  }
  const userCode = requiredString(payload, "user_code", "app registration response did not include user_code");
  return {
    deviceCode: requiredString(payload, "device_code", "app registration response did not include device_code"),
    userCode,
    verificationUri: stringField(payload, "verification_uri") ?? "",
    verificationUriComplete: `${displayEndpoints.open}/page/cli?user_code=${encodeURIComponent(userCode)}`,
    expiresIn: numberField(payload, "expires_in") ?? 300,
    interval: numberField(payload, "interval") ?? 5
  };
}

export async function pollLarkAppRegistration(
  brand: LarkBrand,
  deviceCode: string,
  options: LarkBrowserAuthOptions & { interval?: number; expiresIn?: number } = {}
): Promise<LarkAppRegistrationResult> {
  const first = await pollLarkAppRegistrationOnce(brand, deviceCode, options);
  if (!first.clientSecret && first.tenantBrand === "lark") {
    const retry = await pollLarkAppRegistrationOnce("lark", deviceCode, options);
    return normalizeAppRegistrationResult(retry, "lark");
  }
  return normalizeAppRegistrationResult(first, first.tenantBrand === "lark" ? "lark" : brand);
}

export function buildLarkVerificationUrl(baseUrl: string, cliVersion: string): string {
  const separator = baseUrl.includes("?") ? "&" : "?";
  const version = encodeURIComponent(cliVersion);
  return `${baseUrl}${separator}lpv=${version}&ocv=${version}&from=cli`;
}

export async function requestLarkDeviceAuthorization(
  input: { appId: string; appSecret: string; brand: LarkBrand; scope?: string },
  options: LarkBrowserAuthOptions = {}
): Promise<LarkDeviceAuthorizationResult> {
  const fetch = options.fetch ?? globalFetch;
  const endpoints = resolveLarkEndpoints(input.brand);
  const scope = ensureOfflineAccessScope(input.scope ?? "");
  const body = new URLSearchParams({
    client_id: input.appId,
    scope
  });
  const response = await fetch(`${endpoints.accounts}${LARK_DEVICE_AUTHORIZATION_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${input.appId}:${input.appSecret}`).toString("base64")}`
    },
    body: body.toString(),
    signal: options.signal
  });
  const payload = await readJsonBody(response);
  if (!response.ok || stringField(payload, "error")) {
    throw new TwinnyError(`device authorization failed: ${errorDescription(payload, response.statusText)}`, "LARK_DEVICE_AUTH_FAILED");
  }
  const verificationUri = stringField(payload, "verification_uri") ?? "";
  return {
    deviceCode: requiredString(payload, "device_code", "device authorization response did not include device_code"),
    userCode: requiredString(payload, "user_code", "device authorization response did not include user_code"),
    verificationUri,
    verificationUriComplete: stringField(payload, "verification_uri_complete") ?? verificationUri,
    expiresIn: numberField(payload, "expires_in") ?? 240,
    interval: numberField(payload, "interval") ?? 5
  };
}

export async function pollLarkDeviceToken(
  input: { appId: string; appSecret: string; brand: LarkBrand; deviceCode: string; interval?: number; expiresIn?: number },
  options: LarkBrowserAuthOptions = {}
): Promise<LarkDeviceTokenResult> {
  const fetch = options.fetch ?? globalFetch;
  const endpoints = resolveLarkEndpoints(input.brand);
  const startedAt = options.now?.() ?? Date.now();
  const deadline = startedAt + Math.max(0, input.expiresIn ?? 240) * 1000;
  let interval = Math.max(1, input.interval ?? 5);

  for (let attempt = 0; attempt < maxDeviceTokenPollAttempts && (options.now?.() ?? Date.now()) < deadline; attempt += 1) {
    await sleep(interval * 1000, undefined, { signal: options.signal });
    const body = new URLSearchParams({
      grant_type: deviceCodeGrantType,
      device_code: input.deviceCode,
      client_id: input.appId,
      client_secret: input.appSecret
    });
    const response = await fetch(`${endpoints.openApi}${LARK_OAUTH_TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: options.signal
    });
    const payload = await readJsonBody(response);
    const error = stringField(payload, "error");
    if (response.ok && !error && stringField(payload, "access_token")) {
      const accessToken = requiredString(payload, "access_token", "device token response did not include access_token");
      const refreshToken = stringField(payload, "refresh_token");
      const expiresIn = numberField(payload, "expires_in") ?? 7200;
      return {
        accessToken,
        refreshToken,
        expiresIn,
        refreshExpiresIn: refreshToken ? numberField(payload, "refresh_token_expires_in") ?? 604800 : expiresIn,
        scope: stringField(payload, "scope")
      };
    }
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      interval = Math.min(interval + 5, maxPollIntervalSeconds);
      continue;
    }
    if (error === "access_denied") {
      throw new TwinnyError(errorDescription(payload, "Authorization denied by user"), "LARK_DEVICE_AUTH_DENIED");
    }
    if (error === "expired_token" || error === "invalid_grant") {
      throw new TwinnyError(errorDescription(payload, "Device code expired, please try again"), "LARK_DEVICE_AUTH_EXPIRED");
    }
    throw new TwinnyError(`device token polling failed: ${errorDescription(payload, response.statusText)}`, "LARK_DEVICE_TOKEN_FAILED");
  }
  throw new TwinnyError("device authorization timed out, please try again", "LARK_DEVICE_AUTH_TIMEOUT");
}

export async function getLarkBrowserUserInfo(
  input: { accessToken: string; brand: LarkBrand },
  options: LarkBrowserAuthOptions = {}
): Promise<LarkBrowserUserInfo> {
  const fetch = options.fetch ?? globalFetch;
  const endpoints = resolveLarkEndpoints(input.brand);
  const response = await fetch(`${endpoints.openApi}${LARK_USER_INFO_PATH}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json"
    },
    signal: options.signal
  });
  const payload = await readJsonBody(response);
  const data = recordField(payload, "data");
  const code = numberField(payload, "code") ?? 0;
  if (!response.ok || code !== 0) {
    throw new TwinnyError(`failed to get user info: ${errorDescription(payload, response.statusText)}`, "LARK_USER_INFO_FAILED");
  }
  return {
    openId: requiredString(data, "open_id", "user info response did not include open_id"),
    name: stringField(data, "name") ?? "(unknown)"
  };
}

async function pollLarkAppRegistrationOnce(
  brand: LarkBrand,
  deviceCode: string,
  options: LarkBrowserAuthOptions & { interval?: number; expiresIn?: number }
): Promise<AppRegistrationPollRawResult> {
  const fetch = options.fetch ?? globalFetch;
  const endpoints = resolveLarkEndpoints(brand);
  const startedAt = options.now?.() ?? Date.now();
  const deadline = startedAt + Math.max(0, options.expiresIn ?? 300) * 1000;
  let interval = Math.max(1, options.interval ?? 5);

  for (
    let attempt = 0;
    attempt < maxAppRegistrationPollAttempts && (options.now?.() ?? Date.now()) < deadline;
    attempt += 1
  ) {
    await sleep(interval * 1000, undefined, { signal: options.signal });
    const body = new URLSearchParams({
      action: "poll",
      device_code: deviceCode
    });
    const response = await fetch(`${endpoints.accounts}${LARK_APP_REGISTRATION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: options.signal
    });
    const payload = await readJsonBody(response);
    const error = stringField(payload, "error");
    const clientId = stringField(payload, "client_id");
    if (response.ok && !error && clientId) {
      const userInfo = recordField(payload, "user_info");
      return {
        clientId,
        clientSecret: stringField(payload, "client_secret") ?? "",
        tenantBrand: stringField(userInfo, "tenant_brand"),
        openId: stringField(userInfo, "open_id")
      };
    }
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      interval = Math.min(interval + 5, maxPollIntervalSeconds);
      continue;
    }
    if (error === "access_denied") {
      throw new TwinnyError("app registration denied by user", "LARK_APP_REGISTRATION_DENIED");
    }
    if (error === "expired_token" || error === "invalid_grant") {
      throw new TwinnyError("device code expired, please try again", "LARK_APP_REGISTRATION_EXPIRED");
    }
    throw new TwinnyError(`app registration failed: ${errorDescription(payload, response.statusText)}`, "LARK_APP_REGISTRATION_FAILED");
  }
  throw new TwinnyError("app registration timed out, please try again", "LARK_APP_REGISTRATION_TIMEOUT");
}

function normalizeAppRegistrationResult(raw: AppRegistrationPollRawResult, fallbackBrand: LarkBrand): LarkAppRegistrationResult {
  const brand = raw.tenantBrand === "lark" ? "lark" : raw.tenantBrand === "feishu" ? "feishu" : fallbackBrand;
  if (!raw.clientId || !raw.clientSecret) {
    throw new TwinnyError("app registration succeeded but missing client_id or client_secret", "LARK_APP_REGISTRATION_INCOMPLETE");
  }
  return {
    appId: raw.clientId,
    appSecret: raw.clientSecret,
    brand,
    ownerOpenId: raw.openId
  };
}

function ensureOfflineAccessScope(scope: string): string {
  const scopes = scope.split(/\s+/).map((part) => part.trim()).filter(Boolean);
  if (!scopes.includes("offline_access")) {
    scopes.push("offline_access");
  }
  return scopes.join(" ");
}

async function readJsonBody(response: { json(): Promise<unknown>; text?: () => Promise<string> }): Promise<Record<string, unknown>> {
  const value = await response.json();
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function recordField(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(source: Record<string, unknown>, key: string, message: string): string {
  const value = stringField(source, key);
  if (!value) {
    throw new TwinnyError(message, "LARK_BROWSER_AUTH_RESPONSE_INVALID");
  }
  return value;
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorDescription(payload: Record<string, unknown>, fallback: string): string {
  return stringField(payload, "error_description") ?? stringField(payload, "msg") ?? stringField(payload, "error") ?? fallback;
}

const globalFetch: FetchLike = async (input, init) => {
  if (typeof fetch !== "function") {
    throw new TwinnyError("global fetch is not available in this Node.js runtime", "LARK_FETCH_UNAVAILABLE");
  }
  return fetch(input, init);
};
