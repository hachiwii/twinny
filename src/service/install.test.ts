import { describe, expect, it } from "vitest";
import { managedServiceDisplayName, managedServiceKindForPlatform } from "./install.js";

describe("managed service routing", () => {
  it("uses launchd on macOS and systemd user services on Linux", () => {
    expect(managedServiceKindForPlatform("darwin")).toBe("launchd");
    expect(managedServiceDisplayName("darwin")).toBe("LaunchAgent");
    expect(managedServiceKindForPlatform("linux")).toBe("systemd");
    expect(managedServiceDisplayName("linux")).toBe("systemd user service");
  });

  it("reports unsupported platforms with a foreground-run fallback", () => {
    expect(() => managedServiceKindForPlatform("win32")).toThrow(/Use `twinny run` to run in the foreground/);
  });
});
