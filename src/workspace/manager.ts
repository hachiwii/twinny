import fs from "node:fs";
import path from "node:path";

import { expandHomePath } from "../config/paths.js";
import { TwinnyError } from "../errors.js";
import { DEFAULT_CONVERSATION_WORKSPACE_TEMPLATE, type PermissionsConfig, type RuntimePaths } from "../types.js";
import { assertValidConversationKey, groupConversationKeyPrefix, p2pConversationKeyPrefix } from "./slug.js";

type WorkspaceTemplateConfig = Pick<PermissionsConfig, "p2pDefaultWorkspace" | "groupDefaultWorkspace">;

export interface WorkspaceManagerOptions {
  twinnyHome?: string;
  workspacesDir?: string;
  p2pDefaultWorkspace?: string;
  groupDefaultWorkspace?: string;
}

export class WorkspaceManager {
  readonly twinnyHome: string;
  readonly workspacesDir: string;
  readonly p2pDefaultWorkspace: string;
  readonly groupDefaultWorkspace: string;

  constructor(options: WorkspaceManagerOptions) {
    const workspacesDir = path.resolve(options.workspacesDir ?? path.join(options.twinnyHome ?? process.cwd(), "workspaces"));
    this.twinnyHome = path.resolve(options.twinnyHome ?? path.dirname(workspacesDir));
    this.workspacesDir = workspacesDir;
    this.p2pDefaultWorkspace = normalizeWorkspaceTemplate(options.p2pDefaultWorkspace);
    this.groupDefaultWorkspace = normalizeWorkspaceTemplate(options.groupDefaultWorkspace);
  }

  static fromTwinnyHome(twinnyHome: string, templates: Partial<WorkspaceTemplateConfig> = {}): WorkspaceManager {
    return new WorkspaceManager({
      twinnyHome,
      workspacesDir: path.join(twinnyHome, "workspaces"),
      ...templates
    });
  }

  static fromRuntimePaths(
    paths: Pick<RuntimePaths, "home" | "workspacesDir">,
    templates: Partial<WorkspaceTemplateConfig> = {}
  ): WorkspaceManager {
    return new WorkspaceManager({
      twinnyHome: paths.home,
      workspacesDir: paths.workspacesDir,
      ...templates
    });
  }

  getWorkspacePath(conversationKey: string): string {
    assertValidConversationKey(conversationKey);
    return this.resolveWorkspaceTemplate(this.workspaceTemplateFor(conversationKey), conversationKey);
  }

  ensureWorkspace(conversationKey: string): string {
    const workspace = this.getWorkspacePath(conversationKey);
    if (isPathAtOrInside(this.workspacesDir, workspace)) {
      ensureDirectory(this.workspacesDir, "workspacesDir");
    }
    ensureDirectory(workspace, "workspace");
    return workspace;
  }

  private workspaceTemplateFor(conversationKey: string): string {
    return conversationKey.startsWith(p2pConversationKeyPrefix)
      ? this.p2pDefaultWorkspace
      : this.groupDefaultWorkspace;
  }

  private resolveWorkspaceTemplate(template: string, conversationKey: string): string {
    const rendered = template.replace(/\{\{\s*(twinny_home|conversation_key)\s*\}\}/g, (_match, variable: string) => {
      switch (variable) {
        case "twinny_home":
          return this.twinnyHome;
        case "conversation_key":
          return conversationKey;
        default:
          return "";
      }
    });
    if (/\{\{\s*[^{}]+?\s*\}\}/.test(rendered)) {
      throw new TwinnyError("Workspace template contains unsupported variable", "WORKSPACE_TEMPLATE_INVALID");
    }
    const expanded = expandHomePath(rendered);
    const workspace = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(this.twinnyHome, expanded);
    if (!workspace) {
      throw new TwinnyError("Workspace template resolved to an empty path", "WORKSPACE_TEMPLATE_INVALID");
    }
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

function isPathAtOrInside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeWorkspaceTemplate(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized || DEFAULT_CONVERSATION_WORKSPACE_TEMPLATE;
}
