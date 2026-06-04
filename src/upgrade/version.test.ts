import { describe, expect, it } from "vitest";
import { compareTwinnyVersions, isExpectedTwinnyVersion, parseTwinnyVersion, upgradeTagForChannel } from "./version.js";

describe("Twinny upgrade version comparison", () => {
  it("accepts a.b.c and a.b.c-timestamp formats only", () => {
    expect(parseTwinnyVersion("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseTwinnyVersion("1.2.3-20260605010101")?.suffix).toBe(BigInt("20260605010101"));
    expect(isExpectedTwinnyVersion("dev")).toBe(false);
    expect(isExpectedTwinnyVersion("1.2")).toBe(false);
    expect(isExpectedTwinnyVersion("1.2.3-beta.1")).toBe(false);
  });

  it("compares semver first and treats no suffix as newer for the same base", () => {
    expect(compareTwinnyVersions("1.2.4-20260601", "1.2.3")).toBe(1);
    expect(compareTwinnyVersions("1.2.3", "1.2.3-20260601")).toBe(1);
    expect(compareTwinnyVersions("1.2.3-20260602", "1.2.3-20260601")).toBe(1);
    expect(compareTwinnyVersions("1.2.3-20260601", "1.2.3")).toBe(-1);
    expect(compareTwinnyVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareTwinnyVersions("dev", "1.2.3")).toBeUndefined();
  });

  it("maps upgrade channels to npm dist-tags", () => {
    expect(upgradeTagForChannel("stable")).toBe("latest");
    expect(upgradeTagForChannel("beta")).toBe("beta");
  });
});
