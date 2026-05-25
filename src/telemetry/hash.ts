import { createHmac } from "node:crypto";

export function telemetryHashId(salt: string, kind: string, raw: string): string {
  return createHmac("sha256", salt)
    .update(`${kind}:${raw}`)
    .digest("base64url")
    .slice(0, 32);
}
