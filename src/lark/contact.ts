import { LarkOpenApiClient } from "./openapi.js";

export interface LarkUserDirectoryOptions {
  openApiClient: LarkOpenApiClient;
}

export class LarkUserDirectory {
  constructor(private readonly options: LarkUserDirectoryOptions) {}

  async getUserNameByOpenId(openId: string): Promise<string | undefined> {
    const raw = await this.options.openApiClient.request(`/contact/v3/users/${encodePathSegment(openId)}`, {
      method: "GET",
      query: {
        user_id_type: "open_id"
      }
    });
    return extractUserName(raw);
  }
}

function extractUserName(raw: unknown): string | undefined {
  const data = getRecord(raw, "data");
  const user = getRecord(data, "user");
  return firstNonEmptyString(user.name, user.en_name, user.nickname);
}

function getRecord(source: unknown, key: string): Record<string, unknown> {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }
  const value = (source as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
