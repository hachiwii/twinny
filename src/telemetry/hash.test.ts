import { describe, expect, it } from "vitest";
import { telemetryHashId } from "./hash.js";

describe("telemetryHashId", () => {
  it("is deterministic for the same salt, kind, and raw id", () => {
    expect(telemetryHashId("salt", "lark_open_id", "ou_secret")).toBe(telemetryHashId("salt", "lark_open_id", "ou_secret"));
  });

  it("separates ids by hash kind", () => {
    expect(telemetryHashId("salt", "lark_open_id", "same_raw")).not.toBe(telemetryHashId("salt", "conversation", "same_raw"));
  });

  it("does not expose the raw id in the output", () => {
    const hashed = telemetryHashId("salt", "lark_open_id", "ou_sensitive_identifier");

    expect(hashed).not.toContain("ou_sensitive_identifier");
    expect(hashed).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});
