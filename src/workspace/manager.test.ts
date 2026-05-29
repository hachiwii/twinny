import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceManager } from "./manager.js";
import {
  createGroupConversationKey,
  createP2PConversationKey,
  getGroupChatIdFromConversationKey,
  getP2PChatIdFromConversationKey,
  isValidConversationKey
} from "./slug.js";

describe("WorkspaceManager", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-workspace-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("maps P2P conversation keys directly under TWINNY_HOME/workspaces", () => {
    const manager = WorkspaceManager.fromTwinnyHome(tempDir);
    const conversationKey = createP2PConversationKey("ou_abc");

    const workspace = manager.ensureWorkspace(conversationKey);

    expect(conversationKey).toBe("p2p_ou_abc");
    expect(workspace).toBe(path.join(tempDir, "workspaces", "p2p_ou_abc"));
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
    expect(fs.readdirSync(workspace)).toEqual([]);
    expect(getP2PChatIdFromConversationKey(conversationKey)).toBe("ou_abc");
  });

  it("maps group conversation keys to shared group workspaces", () => {
    const manager = WorkspaceManager.fromTwinnyHome(tempDir);
    const conversationKey = createGroupConversationKey("oc_group");

    const workspace = manager.ensureWorkspace(conversationKey);

    expect(conversationKey).toBe("group_oc_group");
    expect(workspace).toBe(path.join(tempDir, "workspaces", "group_oc_group"));
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
    expect(getGroupChatIdFromConversationKey(conversationKey)).toBe("oc_group");
  });

  it("renders configured P2P and group workspace templates", () => {
    const manager = WorkspaceManager.fromTwinnyHome(tempDir, {
      p2pDefaultWorkspace: "{{twinny_home}}/dm/{{conversation_key}}",
      groupDefaultWorkspace: "{{twinny_home}}/rooms/{{conversation_key}}"
    });

    const p2pWorkspace = manager.ensureWorkspace(createP2PConversationKey("ou_abc"));
    const groupWorkspace = manager.ensureWorkspace(createGroupConversationKey("oc_group"));

    expect(p2pWorkspace).toBe(path.join(tempDir, "dm", "p2p_ou_abc"));
    expect(groupWorkspace).toBe(path.join(tempDir, "rooms", "group_oc_group"));
    expect(fs.statSync(p2pWorkspace).isDirectory()).toBe(true);
    expect(fs.statSync(groupWorkspace).isDirectory()).toBe(true);
  });

  it("uses an existing configured workspace directory when present", () => {
    const existingWorkspace = path.join(tempDir, "existing", "p2p_ou_abc");
    fs.mkdirSync(existingWorkspace, { recursive: true });
    fs.writeFileSync(path.join(existingWorkspace, "marker.txt"), "keep");
    const manager = WorkspaceManager.fromTwinnyHome(tempDir, {
      p2pDefaultWorkspace: "{{twinny_home}}/existing/{{conversation_key}}"
    });

    const workspace = manager.ensureWorkspace(createP2PConversationKey("ou_abc"));

    expect(workspace).toBe(existingWorkspace);
    expect(fs.readFileSync(path.join(workspace, "marker.txt"), "utf8")).toBe("keep");
  });

  it("rejects keys with slashes, empty ids, or dot traversal", () => {
    const manager = WorkspaceManager.fromTwinnyHome(tempDir);

    expect(() => createP2PConversationKey("")).toThrow();
    expect(() => createP2PConversationKey("ou/abc")).toThrow();
    expect(() => createP2PConversationKey("..")).toThrow();
    expect(() => createP2PConversationKey("ou..abc")).toThrow();
    expect(() => createGroupConversationKey("oc/abc")).toThrow();

    expect(isValidConversationKey("p2p_ou_abc")).toBe(true);
    expect(isValidConversationKey("group_oc_group")).toBe(true);
    expect(isValidConversationKey("")).toBe(false);
    expect(isValidConversationKey("p2p_")).toBe(false);
    expect(isValidConversationKey("p2p_../secret")).toBe(false);
    expect(isValidConversationKey("p2p_ou/secret")).toBe(false);
    expect(() => manager.ensureWorkspace("p2p_../secret")).toThrow();
  });
});
