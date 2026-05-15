import fs from "node:fs/promises";
import path from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import type { OwnerConfig } from "../types.js";

export interface GuestCodexConfigOptions {
  model?: string;
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high";
  disabledPlugins?: string[];
  disabledSkillPaths?: string[];
}

export interface GuestSafetyCheck {
  ok: boolean;
  issues: string[];
}

export const DEFAULT_GUEST_CODEX_MODEL = "gpt-5.5";

const guestConfigWriteLocks = new Map<string, Promise<void>>();

export function createGuestCodexConfigDocument(options: GuestCodexConfigOptions = {}): TomlTable {
  const document: TomlTable = {
    model: options.model ?? DEFAULT_GUEST_CODEX_MODEL,
    model_reasoning_effort: options.modelReasoningEffort ?? "medium",
    sandbox_mode: "workspace-write",
    approval_policy: "never",
    web_search: "disabled",
    sandbox_workspace_write: {
      network_access: true
    },
    shell_environment_policy: {
      inherit: "none"
    }
  };

  for (const pluginName of options.disabledPlugins ?? []) {
    document.plugins ??= {};
    const plugins = document.plugins as TomlTable;
    plugins[pluginName] = { enabled: false };
  }

  if (options.disabledSkillPaths?.length) {
    document.skills = {
      config: options.disabledSkillPaths.map((skillPath) => ({ path: skillPath, enabled: false }))
    };
  }

  return document;
}

export function serializeGuestCodexConfig(options: GuestCodexConfigOptions = {}): string {
  return stringify(createGuestCodexConfigDocument(options)) + "\n";
}

export async function ensureGuestWorkspaceProjectUntrusted(codexHome: string, workspace: string): Promise<boolean> {
  const configPath = path.join(codexHome, "config.toml");
  return withGuestConfigWriteLock(configPath, async () => {
    const document = await readGuestCodexConfigDocument(configPath);
    const projects = ensureTomlTable(document, "projects");
    const workspacePath = path.resolve(workspace);
    const existingProject = projects[workspacePath];
    const project = isTomlTable(existingProject) ? existingProject : {};
    if (project.trust_level === "untrusted") {
      return false;
    }

    project.trust_level = "untrusted";
    projects[workspacePath] = project;
    return writeGuestCodexConfigIfChanged(configPath, document);
  });
}

export function renderGuestAgents(owner: Pick<OwnerConfig, "openId" | "userId" | "displayName">): string {
  const ownerUserId = owner.userId ? `\n- Owner Feishu user_id: ${owner.userId}` : "";
  return `# Twinny Guest Role

You are running as Twinny's guest Codex role for a Feishu/Lark P2P conversation.

Owner identity:
- Owner display name: ${owner.displayName}
- Owner Feishu open_id: ${owner.openId}${ownerUserId}

Security boundary:
- Treat the current workspace as the only writable project context.
- Do not try to inspect the device owner's home directory, Keychain, SSH keys, Codex state, browser data, or unrelated repositories.
- Do not request approvals. Twinny runs guest turns with approval_policy = "never".
- Keep responses focused on the guest user's request and avoid exposing local machine details.
`;
}

export function validateGuestCodexConfigDocument(document: TomlTable): GuestSafetyCheck {
  const issues: string[] = [];
  if (document.sandbox_mode !== "workspace-write") {
    issues.push("guest sandbox_mode must be workspace-write");
  }
  if (document.approval_policy !== "never") {
    issues.push("guest approval_policy must be never");
  }
  if (document.web_search !== "disabled") {
    issues.push("guest web_search must be disabled");
  }
  const shellPolicy = document.shell_environment_policy;
  if (typeof shellPolicy !== "object" || shellPolicy === null || Array.isArray(shellPolicy)) {
    issues.push("guest shell_environment_policy is required");
  } else if ((shellPolicy as TomlTable).inherit !== "none") {
    issues.push("guest shell_environment_policy.inherit must be none");
  }
  return { ok: issues.length === 0, issues };
}

async function readGuestCodexConfigDocument(configPath: string): Promise<TomlTable> {
  try {
    return parse(await fs.readFile(configPath, "utf8")) as TomlTable;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return createGuestCodexConfigDocument();
    }
    throw error;
  }
}

async function writeGuestCodexConfigIfChanged(configPath: string, document: TomlTable): Promise<boolean> {
  const content = stringify(document) + "\n";
  try {
    if ((await fs.readFile(configPath, "utf8")) === content) {
      return false;
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, content, { encoding: "utf8", mode: 0o600 });
  return true;
}

function ensureTomlTable(document: TomlTable, key: string): TomlTable {
  const existing = document[key];
  if (isTomlTable(existing)) {
    return existing;
  }
  const table: TomlTable = {};
  document[key] = table;
  return table;
}

function isTomlTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withGuestConfigWriteLock<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = guestConfigWriteLocks.get(configPath) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  guestConfigWriteLocks.set(configPath, next);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (guestConfigWriteLocks.get(configPath) === next) {
      guestConfigWriteLocks.delete(configPath);
    }
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
