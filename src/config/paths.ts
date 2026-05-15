import os from "node:os";
import path from "node:path";
import type { RuntimePaths } from "../types.js";

export const DEFAULT_TWINNY_HOME = "~/.twinny";

export interface ResolveHomeOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function expandHomePath(input: string, homeDir = os.homedir()): string {
  if (input === "~") {
    return homeDir;
  }
  if (input.startsWith("~/")) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

export function resolveTwinnyHome(options: ResolveHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const rawHome = env.TWINNY_HOME?.trim() || DEFAULT_TWINNY_HOME;
  return path.resolve(expandHomePath(rawHome, options.homeDir));
}

export function createRuntimePaths(home = resolveTwinnyHome()): RuntimePaths {
  const resolvedHome = path.resolve(expandHomePath(home));
  const rolesDir = path.join(resolvedHome, "roles");
  const sqliteDir = path.join(resolvedHome, "sqlite");
  const runtimeDir = path.join(resolvedHome, "runtime");

  return {
    home: resolvedHome,
    configFile: path.join(resolvedHome, "config.toml"),
    rolesDir,
    ownerCodexHome: path.join(rolesDir, "owner", "codex"),
    guestCodexHome: path.join(rolesDir, "guest", "codex"),
    sqliteDir,
    sqliteFile: path.join(sqliteDir, "twinny.db"),
    workspacesDir: path.join(resolvedHome, "workspaces"),
    runtimeDir,
    lockFile: path.join(runtimeDir, "twinny.lock"),
    logsDir: path.join(os.homedir(), "Library", "Logs", "twinny")
  };
}

