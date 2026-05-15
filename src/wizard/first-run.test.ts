import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapTwinnyHome, createTwinnyConfig, loadTwinnyConfig, MemorySecretStore, SECRET_ACCOUNTS } from "../config/index.js";
import {
  runFirstRunWizard,
  showWizardIntro,
  wizardDivider,
  wizardOwnerAuthScope,
  wizardProjectDescription,
  wizardProjectName,
  type LarkOwnerAuthClient,
  type WizardPrompt
} from "./first-run.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("first-run wizard", () => {
  it("shows the project banner before prompting", () => {
    const lines: string[] = [];

    showWizardIntro({ writeLine: (line) => lines.push(line) });

    expect(lines).toEqual([
      wizardDivider,
      wizardProjectName,
      "",
      wizardProjectDescription,
      wizardDivider,
      ""
    ]);
    expect(wizardProjectName).toBe("🐰 Twinny");
  });

  it("shows status and runs doctor without prompting when config is complete", async () => {
    const home = await tempHome();
    const config = createTwinnyConfig({
      home,
      lark: { appId: "cli_test" },
      owner: { openId: "ou_owner", displayName: "Owner" }
    });
    await bootstrapTwinnyHome(config, { ownerCodexTarget: path.join(home, ".codex") });

    const secretStore = new MemorySecretStore();
    await secretStore.set(SECRET_ACCOUNTS.larkAppSecret, "secret");
    await secretStore.set(SECRET_ACCOUNTS.ownerUserToken, "owner-token");

    const lines: string[] = [];
    const prompt = vi.fn();
    const doctorHook = vi.fn(async () => undefined);

    const result = await runFirstRunWizard({
      home,
      env: {},
      secretStore,
      prompt: prompt as unknown as WizardPrompt,
      doctorHook,
      output: { writeLine: (line) => lines.push(line) }
    });

    expect(result.mode).toBe("status");
    expect(prompt).not.toHaveBeenCalled();
    expect(doctorHook).toHaveBeenCalledOnce();
    expect(lines).toContain("Twinny is already configured.");
    expect(lines).toContain("Lark app_secret present: yes");
    expect(lines).toContain("Owner user token present: yes");
  });

  it("authorizes the owner and stores discovered identity and tokens", async () => {
    const home = await tempHome();
    const secretStore = new MemorySecretStore();
    const doctorHook = vi.fn(async () => undefined);
    const prompt = (async () => ({
      appId: "cli_authorized",
      appSecret: "authorized-secret"
    })) as WizardPrompt;
    const authClient = {
      requestDeviceAuthorization: vi.fn(async () => ({
        deviceCode: "device-code",
        userCode: "USER-CODE",
        verificationUri: "https://accounts.feishu.cn/page/cli",
        verificationUriComplete: "https://accounts.feishu.cn/page/cli?user_code=USER-CODE",
        expiresIn: 240,
        interval: 1
      })),
      pollDeviceToken: vi.fn(async () => ({
        accessToken: "owner-token",
        refreshToken: "refresh-token",
        expiresIn: 7200,
        refreshTokenExpiresIn: 604800,
        scope: "offline_access"
      })),
      getUserInfo: vi.fn(async () => ({
        openId: "ou_owner",
        userId: "user_owner",
        displayName: "Owner"
      }))
    } satisfies LarkOwnerAuthClient;
    const lines: string[] = [];

    const result = await runFirstRunWizard({
      home,
      env: {},
      interactive: true,
      secretStore,
      prompt,
      authClientFactory: () => authClient,
      doctorHook,
      output: { writeLine: (line) => lines.push(line) }
    });

    const loaded = await loadTwinnyConfig({ home, env: {} });

    expect(result.mode).toBe("authorized");
    expect(authClient.requestDeviceAuthorization).toHaveBeenCalledWith(wizardOwnerAuthScope);
    expect(authClient.pollDeviceToken).toHaveBeenCalledWith({
      deviceCode: "device-code",
      expiresIn: 240,
      interval: 1
    });
    expect(authClient.getUserInfo).toHaveBeenCalledWith("owner-token");
    expect(lines).toContain("https://accounts.feishu.cn/page/cli?user_code=USER-CODE");
    expect(loaded.lark.appId).toBe("cli_authorized");
    expect(loaded.owner.openId).toBe("ou_owner");
    expect(loaded.owner.userId).toBe("user_owner");
    expect(loaded.owner.displayName).toBe("Owner");
    await expect(secretStore.get(SECRET_ACCOUNTS.larkAppSecret)).resolves.toBe("authorized-secret");
    await expect(secretStore.get(SECRET_ACCOUNTS.ownerUserToken)).resolves.toBe("owner-token");
    await expect(secretStore.get(SECRET_ACCOUNTS.ownerRefreshToken)).resolves.toBe("refresh-token");
    expect(await fs.readFile(path.join(home, "roles", "guest", "codex", "AGENTS.md"), "utf8")).toContain("ou_owner");
    expect(doctorHook).toHaveBeenCalledOnce();
  });

});

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-wizard-test-"));
  tempDirs.push(dir);
  return dir;
}
