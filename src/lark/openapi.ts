import { TwinnyError, toErrorMessage } from "../errors.js";
import { DEFAULT_LARK_OPENAPI_BASE_URL, normalizeBaseUrl, TenantAccessTokenManager } from "./auth.js";
import type { FetchLike } from "./types.js";

export interface LarkOpenApiClientOptions {
  tokenManager: TenantAccessTokenManager;
  baseUrl?: string;
  fetch?: FetchLike;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  now?: () => number;
}

export interface LarkOpenApiRequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  retry?: boolean;
}

export class LarkOpenApiError extends TwinnyError {
  constructor(
    message: string,
    readonly detail: { status?: number; code?: number; responseBody?: unknown; retryable?: boolean },
    cause?: unknown
  ) {
    super(message, "LARK_OPENAPI_ERROR", cause);
    this.name = "LarkOpenApiError";
  }
}

export class LarkOpenApiClient {
  private readonly tokenManager: TenantAccessTokenManager;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: LarkOpenApiClientOptions) {
    this.tokenManager = options.tokenManager;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_LARK_OPENAPI_BASE_URL);
    this.fetch = options.fetch ?? globalFetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
  }

  async request(pathname: string, options: LarkOpenApiRequestOptions = {}): Promise<unknown> {
    const retry = options.retry ?? true;
    const attempts = retry ? this.maxRetries + 1 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.requestOnce(pathname, options);
      } catch (error) {
        lastError = error;
        if (attempt >= attempts - 1 || !isRetryableError(error)) {
          break;
        }
        await sleep(this.retryBaseDelayMs * 2 ** attempt);
      }
    }

    throw lastError;
  }

  private async requestOnce(pathname: string, options: LarkOpenApiRequestOptions): Promise<unknown> {
    const token = await this.tokenManager.getTenantAccessToken();
    const response = await this.fetch(this.buildUrl(pathname, options.query), {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });

    const body = await readJsonBody(response);
    const record = toRecord(body);
    const code = typeof record.code === "number" ? record.code : undefined;

    if (!response.ok || (code !== undefined && code !== 0)) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new LarkOpenApiError(
        `Lark OpenAPI request failed: ${formatOpenApiFailure(response, record)}`,
        { status: response.status, code, responseBody: body, retryable }
      );
    }

    return body;
  }

  private buildUrl(pathname: string, query?: Record<string, string | number | boolean | undefined>): string {
    const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof LarkOpenApiError) {
    return error.detail.retryable === true;
  }
  return true;
}

function formatOpenApiFailure(response: { status: number; statusText: string }, body: Record<string, unknown>): string {
  const msg = typeof body.msg === "string" && body.msg.length > 0 ? body.msg : response.statusText;
  return `status=${response.status} code=${String(body.code ?? "unknown")} msg=${msg}`;
}

async function readJsonBody(response: { json(): Promise<unknown>; text?: () => Promise<string> }): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (response.text) {
      try {
        return { raw: await response.text() };
      } catch {
        throw error;
      }
    }
    throw new LarkOpenApiError(`Lark OpenAPI returned invalid JSON: ${toErrorMessage(error)}`, {}, error);
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const globalFetch: FetchLike = async (input, init) => {
  if (typeof fetch !== "function") {
    throw new TwinnyError("global fetch is not available in this Node.js runtime", "LARK_FETCH_UNAVAILABLE");
  }
  return fetch(input, init);
};
