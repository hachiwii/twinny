import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  const sqliteDir = path.join(resolvedHome, "sqlite");
  const runtimeDir = path.join(resolvedHome, "runtime");

  return {
    home: resolvedHome,
    configFile: path.join(resolvedHome, "config.toml"),
    authFile: path.join(resolvedHome, "auth.json"),
    homeRandomFile: path.join(runtimeDir, "home-random"),
    secretsFile: path.join(runtimeDir, "secrets.json"),
    sqliteDir,
    sqliteFile: path.join(sqliteDir, "twinny.db"),
    workspacesDir: path.join(resolvedHome, "workspaces"),
    runtimeDir,
    larkAssetsFile: path.join(runtimeDir, "lark-assets.json"),
    lockFile: path.join(runtimeDir, "twinny.lock"),
    logsDir: resolveLogsDir()
  };
}

function resolveLogsDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Logs", "twinny");
  }
  return path.join(process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state"), "twinny", "logs");
}

export function resolveBundledLogoPath(): string {
  return fileURLToPath(new URL("../../configs/logo.png", import.meta.url));
}

export function resolveBundledBannerPath(): string {
  return fileURLToPath(new URL("../../configs/banner.png", import.meta.url));
}
