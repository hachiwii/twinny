import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTwinnyConfig, MemorySecretStore } from "../config/index.js";
import { LARK_FEATURE_SET_DEFINITIONS } from "../lark/feature-config.js";
import { LARK_REQUIRED_SCOPES } from "../lark/index.js";
import {
  checkCaffeinateBinary,
  checkLarkBotOpenId,
  checkLarkNecessaryFeatureConfiguration,
  checkLarkRequiredScopes,
  formatDoctorCheckLine,
  resolveDoctorLarkAppSecret
} from "./health.js";

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
    await expect(resolveDoctorLarkAppSecret(account, store, "auth-secret-value")).resolves.toEqual({
      value: "auth-secret-value",
      detail: "present"
    });
  });

  it("checks Lark bot open_id through a separate doctor item", async () => {
    const config = createTwinnyConfig({
      home: fs.mkdtempSync(path.join(os.tmpdir(), "twinny-bot-check-")),
      homeRandom: "0123456789abcdef0123456789abcdef",
      auth: { larkAppId: "cli_app", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner User" }
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
      auth: { larkAppId: "cli_app", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner User" }
    });
    tempDirs.push(config.home);

    await expect(
      checkLarkBotOpenId(config, "secret", { botDirectory: { getBotOpenId: vi.fn(async () => undefined) } })
    ).rejects.toThrow("missing bot open_id");
  });

  it("checks Lark required scopes through the tenant scope API", async () => {
    const config = createTwinnyConfig({
      home: fs.mkdtempSync(path.join(os.tmpdir(), "twinny-scope-check-")),
      homeRandom: "0123456789abcdef0123456789abcdef",
      auth: { larkAppId: "cli_app", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner User" }
    });
    tempDirs.push(config.home);
    const request = vi.fn(async () => ({
      data: {
        scopes: [
          { scope_name: "im:message:readonly", grant_status: 1 },
          { scope_name: "im:message:send_as_bot", grant_status: 1 },
          { scope_name: "im:message:update", grant_status: 2 }
        ]
      }
    }));

    await expect(
      checkLarkRequiredScopes(config, "secret", {
        openApiClient: { request },
        requiredScopes: ["im:message:readonly", "im:message:send_as_bot"]
      })
    ).resolves.toBe("2 required scopes granted");
    expect(request).toHaveBeenCalledWith("/application/v6/scopes", { method: "GET" });
  });

  it("keeps doc comment watch permissions narrow in the default doctor scope check", async () => {
    expect(LARK_REQUIRED_SCOPES).toEqual(expect.arrayContaining([
      "contact:user.base:readonly",
      "docs:document.comment:read",
      "docs:document.comment:create",
      "docs:document.comment:write_only",
      "docs:document.media:download",
      "wiki:node:read"
    ]));
    expect(LARK_REQUIRED_SCOPES.some((scope) => scope.startsWith("drive:drive"))).toBe(false);

    const config = createTwinnyConfig({
      home: fs.mkdtempSync(path.join(os.tmpdir(), "twinny-doc-comment-scope-check-")),
      homeRandom: "0123456789abcdef0123456789abcdef",
      auth: { larkAppId: "cli_app", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner User" }
    });
    tempDirs.push(config.home);
    const request = vi.fn(async () => ({
      data: {
        scopes: LARK_REQUIRED_SCOPES.map((scope) => ({
          scope_name: scope,
          grant_status: 1
        }))
      }
    }));

    await expect(
      checkLarkRequiredScopes(config, "secret", {
        openApiClient: { request }
      })
    ).resolves.toBe(`${LARK_REQUIRED_SCOPES.length} required scopes granted`);
  });

  it("accepts broader or legacy group scopes for the group mention requirement", async () => {
    const config = createTwinnyConfig({
      home: fs.mkdtempSync(path.join(os.tmpdir(), "twinny-group-scope-check-")),
      homeRandom: "0123456789abcdef0123456789abcdef",
      auth: { larkAppId: "cli_app", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner User" }
    });
    tempDirs.push(config.home);
    const request = vi.fn(async () => ({
      data: {
        scopes: [
          { scope_name: "im:message.group_msg", grant_status: 1 }
        ]
      }
    }));

    await expect(
      checkLarkRequiredScopes(config, "secret", {
        openApiClient: { request },
        requiredScopes: ["im:message.group_at_msg:readonly"]
      })
    ).resolves.toBe("1 required scopes granted");
  });

  it("accepts the contact base scope alternative for user name lookup", async () => {
    const config = createTwinnyConfig({
      home: fs.mkdtempSync(path.join(os.tmpdir(), "twinny-contact-scope-check-")),
      homeRandom: "0123456789abcdef0123456789abcdef",
      auth: { larkAppId: "cli_app", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner User" }
    });
    tempDirs.push(config.home);
    const request = vi.fn(async () => ({
      data: {
        scopes: [
          { scope_name: "contact:contact.base:readonly", grant_status: 1 }
        ]
      }
    }));

    await expect(
      checkLarkRequiredScopes(config, "secret", {
        openApiClient: { request },
        requiredScopes: ["contact:user.base:readonly"]
      })
    ).resolves.toBe("1 required scopes granted");
  });

  it("lists missing Lark required scopes", async () => {
    const config = createTwinnyConfig({
      home: fs.mkdtempSync(path.join(os.tmpdir(), "twinny-missing-scope-check-")),
      homeRandom: "0123456789abcdef0123456789abcdef",
      auth: { larkAppId: "cli_app", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner User" }
    });
    tempDirs.push(config.home);
    const request = vi.fn(async () => ({
      data: {
        scopes: [
          { scope_name: "im:message:readonly", grant_status: 1 },
          { scope_name: "im:message:update", grant_status: 2 }
        ]
      }
    }));

    await expect(
      checkLarkRequiredScopes(config, "secret", {
        openApiClient: { request },
        requiredScopes: ["im:message:readonly", "im:message:update", "im:message:recall"]
      })
    ).rejects.toThrow("missing: im:message:update, im:message:recall");
  });

  it("checks only the necessary Lark feature set for doctor configuration", async () => {
    const config = createTwinnyConfig({
      home: fs.mkdtempSync(path.join(os.tmpdir(), "twinny-necessary-config-check-")),
      homeRandom: "0123456789abcdef0123456789abcdef",
      auth: { larkAppId: "cli_app", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner User" }
    });
    tempDirs.push(config.home);
    const request = vi.fn(async () => ({
      data: {
        items: [
          {
            version_id: "published",
            version: "1.0.0",
            status: 1,
            publish_time: "2026-05-28",
            scopes: LARK_FEATURE_SET_DEFINITIONS.necessary.scopes.map((scope) => ({
              scope,
              token_types: ["tenant"]
            })),
            event_infos: LARK_FEATURE_SET_DEFINITIONS.necessary.events.map((event) => ({
              event_type: event
            }))
          }
        ]
      }
    }));

    await expect(
      checkLarkNecessaryFeatureConfiguration(config, "secret", {
        openApiClient: { request }
      })
    ).resolves.toMatchObject({ ok: true, skipped: false });
    expect(request).toHaveBeenCalledWith("/application/v6/applications/cli_app/app_versions", {
      method: "GET",
      query: { lang: "zh_cn", page_size: 2 }
    });
  });

  it("skips doctor Lark configuration when app version cannot be queried", async () => {
    const config = createTwinnyConfig({
      home: fs.mkdtempSync(path.join(os.tmpdir(), "twinny-skip-config-check-")),
      homeRandom: "0123456789abcdef0123456789abcdef",
      auth: { larkAppId: "cli_app", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner User" }
    });
    tempDirs.push(config.home);

    await expect(
      checkLarkNecessaryFeatureConfiguration(config, "secret", {
        openApiClient: {
          request: vi.fn(async () => {
            throw new Error("permission denied");
          })
        }
      })
    ).resolves.toMatchObject({ ok: true, skipped: true, skipReason: "permission denied" });
  });

  it("prints SKIP markers for skipped doctor checks", () => {
    expect(formatDoctorCheckLine({
      name: "lark necessary configuration",
      ok: true,
      skipped: true,
      detail: "permission denied"
    })).toBe("SKIP lark necessary configuration - permission denied");
  });
});
