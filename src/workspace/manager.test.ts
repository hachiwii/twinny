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

    expect(conversationKey).toBe("p2p:ou_abc");
    expect(workspace).toBe(path.join(tempDir, "workspaces", "p2p:ou_abc"));
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
    expect(fs.readdirSync(workspace)).toEqual([]);
    expect(getP2PChatIdFromConversationKey(conversationKey)).toBe("ou_abc");
  });

  it("maps group conversation keys to shared group workspaces", () => {
    const manager = WorkspaceManager.fromTwinnyHome(tempDir);
    const conversationKey = createGroupConversationKey("oc_group");

    const workspace = manager.ensureWorkspace(conversationKey);

    expect(conversationKey).toBe("group:oc_group");
    expect(workspace).toBe(path.join(tempDir, "workspaces", "group:oc_group"));
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
    expect(getGroupChatIdFromConversationKey(conversationKey)).toBe("oc_group");
  });

  it("rejects keys with slashes, empty ids, or dot traversal", () => {
    const manager = WorkspaceManager.fromTwinnyHome(tempDir);

    expect(() => createP2PConversationKey("")).toThrow();
    expect(() => createP2PConversationKey("ou/abc")).toThrow();
    expect(() => createP2PConversationKey("..")).toThrow();
    expect(() => createP2PConversationKey("ou..abc")).toThrow();
    expect(() => createGroupConversationKey("oc/abc")).toThrow();

    expect(isValidConversationKey("p2p:ou_abc")).toBe(true);
    expect(isValidConversationKey("group:oc_group")).toBe(true);
    expect(isValidConversationKey("")).toBe(false);
    expect(isValidConversationKey("p2p:")).toBe(false);
    expect(isValidConversationKey("p2p:../secret")).toBe(false);
    expect(isValidConversationKey("p2p:ou/secret")).toBe(false);
    expect(() => manager.ensureWorkspace("p2p:../secret")).toThrow();
  });
});
