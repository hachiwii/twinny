import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGuestCodexConfigDocument,
  ensureGuestWorkspaceProjectUntrusted,
  renderGuestAgents,
  resolveRoleForSender,
  validateGuestCodexConfigDocument
} from "./index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("role helpers", () => {
  it("routes owner open_id to owner and everyone else to guest", () => {
    expect(resolveRoleForSender("ou_owner", "ou_owner")).toBe("owner");
    expect(resolveRoleForSender("ou_guest", "ou_owner")).toBe("guest");
  });

  it("renders guest global instructions with owner identity and validates safe defaults", () => {
    const document = createGuestCodexConfigDocument();
    const agents = renderGuestAgents({ openId: "ou_owner", userId: "user_owner", displayName: "Owner" });

    expect(validateGuestCodexConfigDocument(document)).toEqual({ ok: true, issues: [] });
    expect(agents).toContain("Owner display name: Owner");
    expect(agents).toContain("Owner Feishu open_id: ou_owner");
    expect(agents).toContain("approval_policy = \"never\"");
  });

  it("pre-seeds guest workspace projects as untrusted without dropping existing config", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-roles-"));
    tempDirs.push(tempDir);
    const codexHome = path.join(tempDir, "codex");
    const configPath = path.join(codexHome, "config.toml");
    const workspace = path.join(tempDir, "workspaces", "p2p:ou_guest");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      configPath,
      stringify({
        ...createGuestCodexConfigDocument(),
        projects: {
          [workspace]: { trust_level: "trusted", marker: "keep" },
          "/tmp/other": { trust_level: "trusted" }
        }
      }) + "\n"
    );

    await expect(ensureGuestWorkspaceProjectUntrusted(codexHome, workspace)).resolves.toBe(true);
    await expect(ensureGuestWorkspaceProjectUntrusted(codexHome, workspace)).resolves.toBe(false);

    const document = parse(await fs.readFile(configPath, "utf8")) as TomlTable;
    const projects = document.projects as TomlTable;
    expect(projects[workspace]).toEqual({ trust_level: "untrusted", marker: "keep" });
    expect(projects["/tmp/other"]).toEqual({ trust_level: "trusted" });
    expect(validateGuestCodexConfigDocument(document)).toEqual({ ok: true, issues: [] });
  });
});
