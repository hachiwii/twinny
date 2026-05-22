import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGuestCodexConfigDocument,
  ensureGuestWorkspaceProjectTrusted,
  renderGuestAgents,
  resolveRoleForSender,
  validateGuestCodexConfigDocument
} from "./index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("role helpers", () => {
  it("routes owner open_id to host and everyone else to guest", () => {
    expect(resolveRoleForSender("ou_owner", "ou_owner")).toBe("host");
    expect(resolveRoleForSender("ou_guest", "ou_owner")).toBe("guest");
  });

  it("renders guest global instructions with owner identity and validates safe defaults", () => {
    const document = createGuestCodexConfigDocument();
    const agents = renderGuestAgents({ openId: "ou_owner", userId: "user_owner", displayName: "Owner" });

    expect(validateGuestCodexConfigDocument(document)).toEqual({ ok: true, issues: [] });
    expect(document.default_permissions).toBe("twinny_guest");
    expect(((document.permissions as TomlTable).twinny_guest as TomlTable).network).toEqual({
      enabled: true,
      mode: "full",
      allow_local_binding: true,
      domains: {
        "*": "allow"
      }
    });
    expect(((document.permissions as TomlTable).twinny_guest as TomlTable).filesystem).toEqual({
      ":tmpdir": "write"
    });
    expect(agents).toContain("Owner display name: Owner");
    expect(agents).toContain("Owner Feishu open_id: ou_owner");
    expect(agents).toContain("approval_policy = \"never\"");
    expect(agents).toContain("<mention_lark_user>OPEN_ID</mention_lark_user>");
    expect(agents).toContain("Put only the user's Feishu/Lark open_id inside the tag.");
    expect(agents).not.toContain("Lark @ mention");
    expect(agents).not.toContain("commentary or intermediate progress messages");
  });

  it("pre-seeds guest cwd projects as trusted without dropping existing config", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-roles-"));
    tempDirs.push(tempDir);
    const codexHome = path.join(tempDir, "codex");
    const configPath = path.join(codexHome, "config.toml");
    const workspace = path.join(tempDir, "workspaces", "p2p_ou_guest");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      configPath,
      stringify({
        ...createGuestCodexConfigDocument(),
        projects: {
          [workspace]: { trust_level: "untrusted", marker: "keep" },
          "/tmp/other": { trust_level: "untrusted" }
        }
      }) + "\n"
    );

    await expect(ensureGuestWorkspaceProjectTrusted(codexHome, workspace)).resolves.toBe(true);
    await expect(ensureGuestWorkspaceProjectTrusted(codexHome, workspace)).resolves.toBe(false);

    const document = parse(await fs.readFile(configPath, "utf8")) as TomlTable;
    const projects = document.projects as TomlTable;
    expect(projects[workspace]).toEqual({ trust_level: "trusted", marker: "keep" });
    expect(projects["/tmp/other"]).toEqual({ trust_level: "untrusted" });
    expect(((document.permissions as TomlTable).twinny_guest as TomlTable).network).toMatchObject({
      allow_local_binding: true,
      domains: {
        "*": "allow"
      }
    });
    expect(((document.permissions as TomlTable).twinny_guest as TomlTable).filesystem).toMatchObject({
      ":tmpdir": "write"
    });
    expect(validateGuestCodexConfigDocument(document)).toEqual({ ok: true, issues: [] });
  });

  it("backfills local binding permission into existing guest config", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-roles-"));
    tempDirs.push(tempDir);
    const codexHome = path.join(tempDir, "codex");
    const configPath = path.join(codexHome, "config.toml");
    const workspace = path.join(tempDir, "workspaces", "p2p_ou_guest");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      configPath,
      stringify({
        model: "gpt-5.5",
        sandbox_mode: "workspace-write",
        approval_policy: "never",
        web_search: "disabled",
        shell_environment_policy: { inherit: "none" },
        permissions: {
          twinny_guest: {
            network: {
              enabled: true,
              mode: "full"
            }
          }
        },
        projects: {
          [workspace]: { trust_level: "trusted" }
        }
      }) + "\n"
    );

    await expect(ensureGuestWorkspaceProjectTrusted(codexHome, workspace)).resolves.toBe(true);

    const document = parse(await fs.readFile(configPath, "utf8")) as TomlTable;
    expect(document.default_permissions).toBe("twinny_guest");
    expect(((document.permissions as TomlTable).twinny_guest as TomlTable).network).toEqual({
      enabled: true,
      mode: "full",
      allow_local_binding: true,
      domains: {
        "*": "allow"
      }
    });
    expect(((document.permissions as TomlTable).twinny_guest as TomlTable).filesystem).toEqual({
      ":tmpdir": "write"
    });
    expect(validateGuestCodexConfigDocument(document)).toEqual({ ok: true, issues: [] });
  });

  it("normalizes guest network domains to allow every domain", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-roles-"));
    tempDirs.push(tempDir);
    const codexHome = path.join(tempDir, "codex");
    const configPath = path.join(codexHome, "config.toml");
    const workspace = path.join(tempDir, "workspaces", "p2p_ou_guest");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      configPath,
      stringify({
        ...createGuestCodexConfigDocument(),
        permissions: {
          twinny_guest: {
            network: {
              enabled: true,
              mode: "full",
              allow_local_binding: true,
              domains: {
                "*.feishu.cn": "allow",
                "example.com": "deny"
              }
            },
            filesystem: {
              ":tmpdir": "write"
            }
          }
        },
        projects: {
          [workspace]: { trust_level: "trusted" }
        }
      }) + "\n"
    );

    await expect(ensureGuestWorkspaceProjectTrusted(codexHome, workspace)).resolves.toBe(true);

    const document = parse(await fs.readFile(configPath, "utf8")) as TomlTable;
    expect(((document.permissions as TomlTable).twinny_guest as TomlTable).network).toEqual({
      enabled: true,
      mode: "full",
      allow_local_binding: true,
      domains: {
        "*": "allow"
      }
    });
    expect(validateGuestCodexConfigDocument(document)).toEqual({ ok: true, issues: [] });
  });
});
