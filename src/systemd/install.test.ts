import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSystemdUserServiceUnit, systemdUnitNameForHomeRandom } from "./unit.js";

describe("systemd user service helpers", () => {
  it("renders a user service that runs Twinny through the current Node executable", () => {
    const unitName = systemdUnitNameForHomeRandom("0123456789abcdef0123456789abcdef");
    const unit = createSystemdUserServiceUnit({
      unitName,
      twinnyHome: "/home/tester/.twinny",
      entrypoint: "/home/tester/.twinny/runner/node_modules/.bin/twinny",
      environment: {
        PATH: "/usr/bin",
        TWINNY_LARK_APP_SECRET: undefined
      }
    });

    expect(unit).toContain(`[Unit]\nDescription=Twinny daemon (${unitName})`);
    expect(unit).toContain(`ExecStart="${process.execPath}" "${path.resolve("/home/tester/.twinny/runner/node_modules/.bin/twinny")}" "run"`);
    expect(unit).toContain('Environment="PATH=/usr/bin" "TWINNY_HOME=/home/tester/.twinny"');
    expect(unit).not.toContain("TWINNY_LARK_APP_SECRET");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("derives stable unit names from home random without exposing the raw value", () => {
    const firstRandom = "0123456789abcdef0123456789abcdef";
    const secondRandom = "fedcba9876543210fedcba9876543210";

    expect(systemdUnitNameForHomeRandom(firstRandom)).toBe(systemdUnitNameForHomeRandom(firstRandom));
    expect(systemdUnitNameForHomeRandom(firstRandom)).not.toBe(systemdUnitNameForHomeRandom(secondRandom));
    expect(systemdUnitNameForHomeRandom(firstRandom)).not.toContain(firstRandom);
    expect(systemdUnitNameForHomeRandom(firstRandom)).toMatch(/^twinny-[a-f0-9]{16}\.service$/);
  });

  it("escapes systemd specifiers and dollars in generated units", () => {
    const unit = createSystemdUserServiceUnit({
      twinnyHome: "/home/tester/twinny%home",
      entrypoint: "/home/tester/bin/twinny",
      environment: {
        FOO: "value%with$dollar",
        "bad-key": "ignored"
      }
    });

    expect(unit).toContain("WorkingDirectory=/home/tester/twinny%%home");
    expect(unit).toContain('"FOO=value%%with$$dollar"');
    expect(unit).not.toContain("bad-key");
  });
});
