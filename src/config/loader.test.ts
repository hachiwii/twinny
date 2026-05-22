import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapTwinnyHome,
  createTwinnyConfig,
  loadTwinnyConfig,
  MemorySecretStore,
  parseTwinnyConfig,
  readConfigStatus,
  resolveSecretRef,
  resolveTwinnyHome,
  SECRET_ACCOUNTS,
  SECRET_REFS,
  serializeTwinnyConfig,
  writeLarkIconImageKey
} from "./index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Twinny config loading and bootstrap", () => {
  it("defaults TWINNY_HOME to ~/.twinny", () => {
    expect(resolveTwinnyHome({ env: {}, homeDir: "/Users/tester" })).toBe("/Users/tester/.twinny");
  });

  it("writes and reloads config.toml with smol-toml shape", async () => {
    const home = await tempHome();
    const config = createTwinnyConfig({
      home,
      lark: {
        appId: "cli_test",
        workingReaction: "JubilantRabbit",
        completedReaction: "CheckMark",
        queuedReaction: "OneSecond",
        maxMessageAgeSeconds: 30
      },
      owner: {
        openId: "ou_owner",
        userId: "user_owner",
        displayName: "Owner",
        refreshTokenRef: SECRET_REFS.ownerRefreshToken
      }
    });

    await bootstrapTwinnyHome(config, { ownerCodexTarget: path.join(home, ".codex") });
    const loaded = await loadTwinnyConfig({ home, env: {} });

    expect(loaded.lark.appId).toBe("cli_test");
    expect(loaded.lark.workingReaction).toBe("JubilantRabbit");
    expect(loaded.lark.completedReaction).toBe("CheckMark");
    expect(loaded.lark.queuedReaction).toBe("OneSecond");
    expect(loaded.lark.maxMessageAgeSeconds).toBe(30);
    expect(loaded.lark.messageRedaction).toEqual({ email: "mask", chinesePhoneNumber: "mask" });
    expect(loaded.owner.openId).toBe("ou_owner");
    expect(loaded.roles.owner.codexHome).toBe(path.join(home, "roles", "owner", "codex"));
    expect(loaded.roles.guest.codexHome).toBe(path.join(home, "roles", "guest", "codex"));
  });

  it("ignores legacy agent message mode and serializes icon image key and message redaction", () => {
    const config = parseTwinnyConfig(
      [
        "[lark]",
        'app_id = "cli_test"',
        'queued_reaction = "Alarm"',
        'agent_message_mode = "plain"',
        'icon_image_key = "img_logo"',
        "",
        "[lark.redaction]",
        'email = "whitespace"',
        'chinese_phone_number = "none"',
        "",
        "[owner]",
        'open_id = "ou_owner"',
        'display_name = "Owner"'
      ].join("\n"),
      { home: "/tmp/twinny" }
    );

    expect(config.lark.queuedReaction).toBe("Alarm");
    expect(config.lark.iconImageKey).toBe("img_logo");
    expect(config.lark.messageRedaction).toEqual({ email: "whitespace", chinesePhoneNumber: "none" });
    expect(serializeTwinnyConfig(config)).not.toContain("agent_message_mode");
    expect(serializeTwinnyConfig(config)).toContain('queued_reaction = "Alarm"');
    expect(serializeTwinnyConfig(config)).toContain('icon_image_key = "img_logo"');
    expect(serializeTwinnyConfig(config)).toContain("[lark.redaction]");
    expect(serializeTwinnyConfig(config)).toContain('email = "whitespace"');
    expect(serializeTwinnyConfig(config)).toContain('chinese_phone_number = "none"');
  });

  it("writes icon_image_key back into the lark section", async () => {
    const home = await tempHome();
    const config = createTwinnyConfig({
      home,
      lark: { appId: "cli_test" },
      owner: {
        openId: "ou_owner",
        displayName: "Owner"
      }
    });

    await bootstrapTwinnyHome(config, { ownerCodexTarget: path.join(home, ".codex") });
    await writeLarkIconImageKey(config, "img_uploaded");
    const raw = await fs.readFile(path.join(home, "config.toml"), "utf8");
    const loaded = await loadTwinnyConfig({ home, env: {} });

    expect(raw).toContain('icon_image_key = "img_uploaded"');
    expect(loaded.lark.iconImageKey).toBe("img_uploaded");
  });

  it("creates the required role files and owner codex symlink", async () => {
    const home = await tempHome();
    const ownerCodexTarget = path.join(home, "real-owner-codex");
    await fs.mkdir(path.join(ownerCodexTarget, "sessions"), { recursive: true });
    await fs.writeFile(path.join(ownerCodexTarget, "auth.json"), "{}\n");

    const config = createTwinnyConfig({
      home,
      lark: { appId: "cli_test" },
      owner: {
        openId: "ou_owner",
        displayName: "Owner"
      }
    });

    const result = await bootstrapTwinnyHome(config, { ownerCodexTarget });
    const ownerLink = await fs.lstat(config.roles.owner.codexHome);
    const guestAuthLink = await fs.lstat(path.join(config.roles.guest.codexHome, "auth.json"));
    const guestSessionsLink = await fs.lstat(path.join(config.roles.guest.codexHome, "sessions"));
    const guestConfig = await fs.readFile(path.join(config.roles.guest.codexHome, "config.toml"), "utf8");
    const guestAgents = await fs.readFile(path.join(config.roles.guest.codexHome, "AGENTS.md"), "utf8");

    expect(result.wroteConfig).toBe(true);
    expect(result.createdGuestAuthSymlink).toBe(true);
    expect(result.createdGuestSessionsSymlink).toBe(true);
    expect(ownerLink.isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(config.roles.owner.codexHome), await fs.readlink(config.roles.owner.codexHome))).toBe(
      ownerCodexTarget
    );
    expect(guestAuthLink.isSymbolicLink()).toBe(true);
    expect(
      path.resolve(
        config.roles.guest.codexHome,
        await fs.readlink(path.join(config.roles.guest.codexHome, "auth.json"))
      )
    ).toBe(path.join(ownerCodexTarget, "auth.json"));
    expect(guestSessionsLink.isSymbolicLink()).toBe(true);
    expect(
      path.resolve(
        config.roles.guest.codexHome,
        await fs.readlink(path.join(config.roles.guest.codexHome, "sessions"))
      )
    ).toBe(path.join(ownerCodexTarget, "sessions"));
    expect(guestConfig).toContain('sandbox_mode = "workspace-write"');
    expect(guestConfig).toContain('approval_policy = "never"');
    expect(guestConfig).toContain('default_permissions = "twinny_guest"');
    expect(guestConfig).toContain('":tmpdir" = "write"');
    expect(guestConfig).toContain("allow_local_binding = true");
    expect(guestConfig).toContain('inherit = "none"');
    expect(guestAgents).toContain("Owner");
    expect(guestAgents).toContain("ou_owner");
  });

  it("reports incomplete config without treating it as complete", async () => {
    const home = await tempHome();
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "config.toml"), "[lark]\napp_id = \"cli_test\"\n");

    const status = await readConfigStatus({ home, env: {} });

    expect(status.exists).toBe(true);
    expect(status.complete).toBe(false);
    expect(status.config?.lark.workingReaction).toBe("Typing");
    expect(status.config?.lark.completedReaction).toBe("DONE");
    expect(status.config?.lark.queuedReaction).toBe("OneSecond");
    expect(status.config?.lark.maxMessageAgeSeconds).toBe(60);
    expect(status.config?.lark.messageRedaction).toEqual({ email: "mask", chinesePhoneNumber: "mask" });
    expect(status.issues).toContain("owner.open_id is required");
  });
});

describe("secrets", () => {
  it("resolves secrets through the SecretStore abstraction with env override for app_secret", async () => {
    const store = new MemorySecretStore();
    await store.set(SECRET_ACCOUNTS.larkAppSecret, "from-store");

    await expect(resolveSecretRef(SECRET_REFS.larkAppSecret, store, {})).resolves.toBe("from-store");
    await expect(resolveSecretRef(SECRET_REFS.larkAppSecret, store, { TWINNY_LARK_APP_SECRET: "from-env" })).resolves.toBe(
      "from-env"
    );
  });
});

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-config-test-"));
  tempDirs.push(dir);
  return dir;
}
