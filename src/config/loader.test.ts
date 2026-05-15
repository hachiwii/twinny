import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapTwinnyHome,
  createTwinnyConfig,
  loadTwinnyConfig,
  MemorySecretStore,
  readConfigStatus,
  resolveSecretRef,
  resolveTwinnyHome,
  SECRET_ACCOUNTS,
  SECRET_REFS
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
      lark: { appId: "cli_test", workingReaction: "JubilantRabbit" },
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
    expect(loaded.autoApproval).toEqual({ enabled: false, pollIntervalMs: 60_000, definitionCode: undefined });
    expect(loaded.owner.openId).toBe("ou_owner");
    expect(loaded.roles.owner.codexHome).toBe(path.join(home, "roles", "owner", "codex"));
    expect(loaded.roles.guest.codexHome).toBe(path.join(home, "roles", "guest", "codex"));
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
    expect(status.issues).toContain("owner.open_id is required");
  });

  it("validates auto approval definition code and poll interval only when enabled", async () => {
    const home = await tempHome();
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "config.toml"),
      `
[home]
path = "${home}"

[codex]
binary = "codex"
app_server_listen = "stdio://"

[lark]
identity = "bot"
app_id = "cli_test"
event_key = "im.message.receive_v1"
secret_ref = "keychain:twinny/lark/app_secret"

[auto_approval]
enabled = true
poll_interval_ms = 5000

[owner]
open_id = "ou_owner"
display_name = "Owner"
token_ref = "keychain:twinny/lark/owner_user_token"

[roles.owner]
codex_home = "roles/owner/codex"

[roles.guest]
codex_home = "roles/guest/codex"
`
    );

    const status = await readConfigStatus({ home, env: {} });

    expect(status.issues).toContain("auto_approval.definition_code is required when auto_approval.enabled is true");
    expect(status.issues).toContain("auto_approval.poll_interval_ms must be at least 10000");
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
