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
  resolveLarkAppSecret,
  resolveTwinnyHome,
  serializeTwinnyConfig
} from "./index.js";

const tempDirs: string[] = [];
const homeRandom = "0123456789abcdef0123456789abcdef";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Twinny config loading and bootstrap", () => {
  it("defaults TWINNY_HOME to ~/.twinny", () => {
    expect(resolveTwinnyHome({ env: {}, homeDir: "/Users/tester" })).toBe("/Users/tester/.twinny");
  });

  it("writes and reloads config.toml, auth.json, and runtime/home-random", async () => {
    const home = await tempHome();
    const config = createTwinnyConfig({
      home,
      homeRandom,
      auth: {
        larkAppId: "cli_test",
        larkBrand: "feishu",
        ownerOpenId: "ou_owner",
        displayName: "Owner"
      },
      lark: {
        workingReaction: "JubilantRabbit",
        queuedReaction: "OneSecond",
        messageRedaction: { email: "whitespace" }
      },
      permissions: { p2pDefaultProfile: "none" },
      profiles: {
        host: { codexHome: path.join(home, ".codex"), defaultModel: "gpt-5.5", defaultEffort: "high" },
        guest: {}
      }
    });

    const result = await bootstrapTwinnyHome(config);
    const loaded = await loadTwinnyConfig({ home, env: {} });
    const rawConfig = await fs.readFile(path.join(home, "config.toml"), "utf8");
    const rawAuth = await fs.readFile(path.join(home, "auth.json"), "utf8");
    const rawRandom = await fs.readFile(path.join(home, "runtime", "home-random"), "utf8");

    expect(result).toMatchObject({ wroteConfig: true, wroteAuth: true, wroteHomeRandom: true });
    expect(loaded.auth).toEqual({ larkAppId: "cli_test", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner" });
    expect(loaded.owner).toEqual({ openId: "ou_owner", displayName: "Owner" });
    expect(loaded.homeIdentity.random).toBe(homeRandom);
    expect(loaded.homeIdentity.keychainAccounts.larkAppSecret).toBe(`twinny.home.${homeRandom}.lark.app_secret`);
    expect(loaded.lark.workingReaction).toBe("JubilantRabbit");
    expect(loaded.lark.completedReaction).toBe("DONE");
    expect(loaded.lark.queuedReaction).toBe("OneSecond");
    expect(loaded.lark.messageRedaction).toEqual({ email: "whitespace", chinesePhoneNumber: "mask" });
    expect(loaded.profiles.host.codexHome).toBe(path.join(home, ".codex"));
    expect(loaded.profiles.guest.codexHome).toBe(path.join(home, ".codex"));
    expect(rawRandom.trim()).toBe(homeRandom);
    expect(JSON.parse(rawAuth)).toEqual({
      lark_app_id: "cli_test",
      lark_brand: "feishu",
      owner_open_id: "ou_owner",
      displayName: "Owner"
    });
    expect(rawConfig).not.toContain("[roles");
    expect(rawConfig).not.toContain("app_id");
    expect(rawConfig).not.toContain("owner_open_id");
    expect(rawConfig).not.toContain("secret_ref");
    await expect(fs.stat(path.join(home, "roles"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes only the new config shape", () => {
    const config = createTwinnyConfig({
      home: "/tmp/twinny",
      homeRandom,
      auth: { larkAppId: "cli_test", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner" },
      profiles: {
        host: { codexHome: "/Users/tester/.codex" },
        guest: {}
      }
    });

    const serialized = serializeTwinnyConfig(config);

    expect(serialized).toContain("[profiles.host]");
    expect(serialized).toContain("[profiles.guest]");
    expect(serialized).toContain("[permissions]");
    expect(serialized).not.toContain("[owner]");
    expect(serialized).not.toContain("[roles");
    expect(serialized).not.toContain("secret_ref");
  });

  it("rejects old config fields instead of keeping compatibility", () => {
    expect(() =>
      parseTwinnyConfig(
        [
          "[lark]",
          'app_id = "cli_test"',
          'secret_ref = "keychain:twinny/lark/app_secret"',
          "",
          "[owner]",
          'open_id = "ou_owner"',
          "",
          "[roles.guest]",
          'codex_home = "/tmp/guest"'
        ].join("\n"),
        { home: "/tmp/twinny" }
      )
    ).toThrow();
  });

  it("reports missing auth.json and runtime/home-random as incomplete setup", async () => {
    const home = await tempHome();
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "config.toml"), "[profiles.host]\ncodex_home = \"~/.codex\"\n[profiles.guest]\n");

    const status = await readConfigStatus({ home, env: {} });

    expect(status.exists).toBe(true);
    expect(status.complete).toBe(false);
    expect(status.issues).toContain("auth.json does not exist");
    expect(status.issues).toContain("runtime/home-random does not exist");
  });
});

describe("secrets", () => {
  it("resolves the per-home lark app secret account with env override", async () => {
    const store = new MemorySecretStore();
    const account = `twinny.home.${homeRandom}.lark.app_secret`;
    await store.set(account, "from-store");

    await expect(resolveLarkAppSecret(account, store, {})).resolves.toBe("from-store");
    await expect(resolveLarkAppSecret(account, store, { TWINNY_LARK_APP_SECRET: "from-env" })).resolves.toBe("from-env");
  });
});

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-config-test-"));
  tempDirs.push(dir);
  return dir;
}
