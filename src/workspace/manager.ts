import fs from "node:fs";
import path from "node:path";

import { TwinnyError } from "../errors.js";
import type { RuntimePaths } from "../types.js";
import { assertValidConversationKey } from "./slug.js";

export interface WorkspaceManagerOptions {
  workspacesDir: string;
}

export class WorkspaceManager {
  readonly workspacesDir: string;

  constructor(options: WorkspaceManagerOptions) {
    this.workspacesDir = path.resolve(options.workspacesDir);
  }

  static fromTwinnyHome(twinnyHome: string): WorkspaceManager {
    return new WorkspaceManager({ workspacesDir: path.join(twinnyHome, "workspaces") });
  }

  static fromRuntimePaths(paths: Pick<RuntimePaths, "workspacesDir">): WorkspaceManager {
    return new WorkspaceManager({ workspacesDir: paths.workspacesDir });
  }

  getWorkspacePath(conversationKey: string): string {
    assertValidConversationKey(conversationKey);
    const workspace = path.resolve(this.workspacesDir, conversationKey);
    assertPathInside(this.workspacesDir, workspace);
    return workspace;
  }

  ensureWorkspace(conversationKey: string): string {
    const workspace = this.getWorkspacePath(conversationKey);
    ensureDirectory(this.workspacesDir, "workspacesDir");
    ensureDirectory(workspace, "workspace");
    return workspace;
  }
}

export function getWorkspacePath(twinnyHome: string, conversationKey: string): string {
  return WorkspaceManager.fromTwinnyHome(twinnyHome).getWorkspacePath(conversationKey);
}

export function ensureWorkspace(twinnyHome: string, conversationKey: string): string {
  return WorkspaceManager.fromTwinnyHome(twinnyHome).ensureWorkspace(conversationKey);
}

function ensureDirectory(directory: string, field: string): void {
  const existing = safeLstat(directory);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new TwinnyError(`${field} must not be a symbolic link`, "WORKSPACE_SYMLINK");
    }
    if (!existing.isDirectory()) {
      throw new TwinnyError(`${field} must be a directory`, "WORKSPACE_PATH_NOT_DIRECTORY");
    }
    return;
  }

  fs.mkdirSync(directory, { recursive: true });
  const created = fs.lstatSync(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new TwinnyError(`${field} must be a real directory`, "WORKSPACE_PATH_INVALID");
  }
}

function safeLstat(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function assertPathInside(root: string, child: string): void {
  const relative = path.relative(root, child);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TwinnyError("Workspace path escaped the workspaces directory", "WORKSPACE_PATH_ESCAPE");
  }
}
