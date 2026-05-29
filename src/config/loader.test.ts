import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapTwinnyHome,
  createDefaultSecretStore,
  createTwinnyConfig,
  FileSecretStore,
  loadTwinnyConfig,
  MemorySecretStore,
  parseTwinnyConfig,
  readConfigStatus,
  resolveLarkAppSecret,
  resolveTwinnyHome,
  serializeTwinnyConfig,
  writeLarkCliProfileConfig
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
    expect(rawConfig).not.toContain("[telemetry]");
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
    expect(serialized).toContain('working = "JubilantRabbit"');
    expect(serialized).not.toContain("masquerade_as_codex_cli");
    expect(serialized).not.toContain("[service]");
    expect(serialized).not.toContain("[telemetry]");
    expect(serialized).not.toContain("[owner]");
    expect(serialized).not.toContain("[roles");
    expect(serialized).not.toContain("secret_ref");
  });

  it("round-trips Codex CLI masquerade configuration", () => {
    const config = createTwinnyConfig({
      home: "/tmp/twinny",
      homeRandom,
      auth: { larkAppId: "cli_test", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner" },
      codex: {
        binary: "/opt/homebrew/bin/codex",
        masqueradeAsCodexCli: true
      },
      profiles: {
        host: {},
        guest: {}
      }
    });

    const serialized = serializeTwinnyConfig(config);
    const parsed = parseTwinnyConfig(serialized, { home: "/tmp/twinny" });

    expect(serialized).toContain('masquerade_as_codex_cli = true');
    expect(parsed.codex).toEqual({
      binary: "/opt/homebrew/bin/codex",
      masqueradeAsCodexCli: true
    });
  });

  it("round-trips LaunchDaemon service configuration", () => {
    const config = createTwinnyConfig({
      home: "/tmp/twinny",
      homeRandom,
      auth: { larkAppId: "cli_test", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner" },
      service: {
        launchd: {
          mode: "daemon",
          userName: "tester"
        }
      },
      profiles: {
        host: {},
        guest: {}
      }
    });

    const serialized = serializeTwinnyConfig(config);
    const parsed = parseTwinnyConfig(serialized, { home: "/tmp/twinny" });

    expect(serialized).toContain("[service.launchd]");
    expect(serialized).toContain('mode = "daemon"');
    expect(serialized).toContain('user_name = "tester"');
    expect(parsed.service.launchd).toEqual({ mode: "daemon", userName: "tester" });
  });

  it("round-trips telemetry configuration", () => {
    const config = createTwinnyConfig({
      home: "/tmp/twinny",
      homeRandom,
      auth: { larkAppId: "cli_test", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner" },
      telemetry: {
        enabled: true,
        posthogProjectToken: "ph_test",
        posthogHost: "https://posthog.example"
      },
      profiles: {
        host: {},
        guest: {}
      }
    });

    const serialized = serializeTwinnyConfig(config);
    const parsed = parseTwinnyConfig(serialized, { home: "/tmp/twinny" });

    expect(serialized).toContain("[telemetry]");
    expect(serialized).toContain('enabled = true');
    expect(serialized).toContain('posthog_project_token = "ph_test"');
    expect(parsed.telemetry).toEqual({
      enabled: true,
      posthogProjectToken: "ph_test",
      posthogHost: "https://posthog.example"
    });
  });

  it("loads optional lark-cli profile metadata from Twinny home", async () => {
    const home = await tempHome();
    const config = createTwinnyConfig({
      home,
      homeRandom,
      auth: { larkAppId: "cli_test", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner" },
      profiles: { host: {}, guest: {} }
    });

    await bootstrapTwinnyHome(config);
    await writeLarkCliProfileConfig({ profileName: "cli_test" }, path.join(home, "lark-cli-profile.json"));

    await expect(loadTwinnyConfig({ home, env: {} })).resolves.toMatchObject({
      larkCliProfile: { profileName: "cli_test" }
    });
  });

  it("round-trips an optional lark app secret in auth.json", async () => {
    const home = await tempHome();
    const config = createTwinnyConfig({
      home,
      homeRandom,
      auth: {
        larkAppId: "cli_test",
        larkAppSecret: "from-auth",
        larkBrand: "feishu",
        ownerOpenId: "ou_owner",
        displayName: "Owner"
      },
      profiles: { host: {}, guest: {} }
    });

    await bootstrapTwinnyHome(config);

    const loaded = await loadTwinnyConfig({ home, env: {} });
    const rawAuth = await fs.readFile(path.join(home, "auth.json"), "utf8");
    const rawConfig = await fs.readFile(path.join(home, "config.toml"), "utf8");

    expect(loaded.auth.larkAppSecret).toBe("from-auth");
    expect(JSON.parse(rawAuth)).toMatchObject({ lark_app_secret: "from-auth" });
    expect(rawConfig).not.toContain("from-auth");
  });

  it("serializes telemetry only when disabled or overridden", () => {
    const disabled = createTwinnyConfig({
      home: "/tmp/twinny",
      homeRandom,
      auth: { larkAppId: "cli_test", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner" },
      telemetry: { enabled: false },
      profiles: { host: {}, guest: {} }
    });

    const serialized = serializeTwinnyConfig(disabled);
    const parsed = parseTwinnyConfig(serialized, { home: "/tmp/twinny" });

    expect(serialized).toContain("[telemetry]");
    expect(serialized).toContain("enabled = false");
    expect(serialized).not.toContain("posthog_project_token");
    expect(serialized).not.toContain("posthog_host");
    expect(parsed.telemetry?.enabled).toBe(false);
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
  it("resolves the lark app secret from auth, env, or secret store", async () => {
    const store = new MemorySecretStore();
    const account = `twinny.home.${homeRandom}.lark.app_secret`;
    await store.set(account, "from-store");

    await expect(resolveLarkAppSecret(account, store, {})).resolves.toBe("from-store");
    await expect(resolveLarkAppSecret(account, store, { TWINNY_LARK_APP_SECRET: "from-env" })).resolves.toBe("from-env");
    await expect(resolveLarkAppSecret(account, store, { TWINNY_LARK_APP_SECRET: "from-env" }, "from-auth")).resolves.toBe("from-auth");
  });

  it("stores file-backed secrets in a 0600 JSON file", async () => {
    const home = await tempHome();
    const paths = {
      secretsFile: path.join(home, "runtime", "secrets.json")
    };
    const account = `twinny.home.${homeRandom}.lark.app_secret`;
    const store = createDefaultSecretStore({ platform: "linux", paths });

    await store.set(account, "from-file");

    await expect(resolveLarkAppSecret(account, store, {})).resolves.toBe("from-file");
    await expect(fs.readFile(paths.secretsFile, "utf8")).resolves.toContain("from-file");
    const mode = (await fs.stat(paths.secretsFile)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("can delete file-backed secrets", async () => {
    const home = await tempHome();
    const account = `twinny.home.${homeRandom}.lark.app_secret`;
    const store = new FileSecretStore({ filePath: path.join(home, "runtime", "secrets.json") });

    await store.set(account, "from-file");
    await expect(store.has(account)).resolves.toBe(true);
    await store.delete(account);

    await expect(store.get(account)).resolves.toBeNull();
  });
});

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-config-test-"));
  tempDirs.push(dir);
  return dir;
}
