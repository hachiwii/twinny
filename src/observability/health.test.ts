import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTwinnyConfig, MemorySecretStore } from "../config/index.js";
import { checkCaffeinateBinary, checkLarkBotOpenId, resolveDoctorLarkAppSecret } from "./health.js";

describe("doctor health checks", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("checks that caffeinate is executable on macOS", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-caffeinate-"));
    tempDirs.push(tempDir);
    const command = path.join(tempDir, "caffeinate");
    fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    await expect(checkCaffeinateBinary({ command, platform: "darwin" })).resolves.toBe(command);
  });

  it("fails the caffeinate check when the executable is missing", async () => {
    await expect(
      checkCaffeinateBinary({
        command: path.join(os.tmpdir(), "missing-twinny-caffeinate"),
        platform: "darwin"
      })
    ).rejects.toThrow();
  });

  it("skips caffeinate on non-macOS platforms", async () => {
    await expect(checkCaffeinateBinary({ platform: "linux" })).resolves.toBe("not required on linux");
  });

  it("keeps resolved secret values out of doctor detail", async () => {
    const store = new MemorySecretStore();
    const account = "twinny.home.0123456789abcdef0123456789abcdef.lark.app_secret";
    await store.set(account, "super-secret-value");

    await expect(resolveDoctorLarkAppSecret(account, store)).resolves.toEqual({
      value: "super-secret-value",
      detail: "present"
    });
  });

  it("checks Lark bot open_id through a separate doctor item", async () => {
    const config = createTwinnyConfig({
      home: fs.mkdtempSync(path.join(os.tmpdir(), "twinny-bot-check-")),
      homeRandom: "0123456789abcdef0123456789abcdef",
      auth: { larkAppId: "cli_app", ownerOpenId: "ou_owner", displayName: "Owner User" }
    });
    tempDirs.push(config.home);
    const getBotOpenId = vi.fn(async () => "ou_bot");

    await expect(checkLarkBotOpenId(config, "secret", { botDirectory: { getBotOpenId } })).resolves.toBe("ou_bot");
    expect(getBotOpenId).toHaveBeenCalledOnce();
  });

  it("fails the Lark bot open_id check when the API response is empty", async () => {
    const config = createTwinnyConfig({
      home: fs.mkdtempSync(path.join(os.tmpdir(), "twinny-bot-check-empty-")),
      homeRandom: "0123456789abcdef0123456789abcdef",
      auth: { larkAppId: "cli_app", ownerOpenId: "ou_owner", displayName: "Owner User" }
    });
    tempDirs.push(config.home);

    await expect(
      checkLarkBotOpenId(config, "secret", { botDirectory: { getBotOpenId: vi.fn(async () => undefined) } })
    ).rejects.toThrow("missing bot open_id");
  });
});
