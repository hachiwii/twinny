import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RuntimePaths, TwinnyConfig } from "../types.js";
import { defaultOwnerCodexTarget, renderGuestAgents, serializeGuestCodexConfig, type GuestCodexConfigOptions } from "../roles/index.js";
import { createRuntimePaths } from "./paths.js";
import { writeTwinnyConfig } from "./loader.js";

export interface BootstrapTwinnyHomeOptions {
  overwriteConfig?: boolean;
  ownerCodexTarget?: string;
  guestAuthTarget?: string;
  guestSessionsTarget?: string;
  guestCodexConfig?: GuestCodexConfigOptions;
}

export interface BootstrapTwinnyHomeResult {
  paths: RuntimePaths;
  wroteConfig: boolean;
  createdOwnerSymlink: boolean;
  createdGuestAuthSymlink: boolean;
  createdGuestSessionsSymlink: boolean;
  wroteGuestConfig: boolean;
  wroteGuestAgents: boolean;
}

export async function bootstrapTwinnyHome(
  config: TwinnyConfig,
  options: BootstrapTwinnyHomeOptions = {}
): Promise<BootstrapTwinnyHomeResult> {
  const paths = createRuntimePaths(config.home);
  await ensureTwinnyHomeDirectories(paths);
  const ownerCodexTarget = options.ownerCodexTarget ?? defaultOwnerCodexTarget(os.homedir());
  const createdOwnerSymlink = await ensureOwnerCodexSymlink(
    config.roles.owner.codexHome,
    ownerCodexTarget
  );
  const createdGuestAuthSymlink = await ensureGuestAuthSymlink(
    path.join(config.roles.guest.codexHome, "auth.json"),
    options.guestAuthTarget ?? path.join(ownerCodexTarget, "auth.json")
  );
  const createdGuestSessionsSymlink = await ensureGuestSessionsSymlink(
    path.join(config.roles.guest.codexHome, "sessions"),
    options.guestSessionsTarget ?? path.join(ownerCodexTarget, "sessions")
  );

  const wroteGuestConfig = await writeFileIfChanged(
    path.join(config.roles.guest.codexHome, "config.toml"),
    serializeGuestCodexConfig(options.guestCodexConfig)
  );
  const wroteGuestAgents = await writeFileIfChanged(
    path.join(config.roles.guest.codexHome, "AGENTS.md"),
    renderGuestAgents(config.owner)
  );

  let wroteConfig = false;
  if (options.overwriteConfig || !(await pathExists(paths.configFile))) {
    await writeTwinnyConfig(config, paths.configFile);
    wroteConfig = true;
  }

  return {
    paths,
    wroteConfig,
    createdOwnerSymlink,
    createdGuestAuthSymlink,
    createdGuestSessionsSymlink,
    wroteGuestConfig,
    wroteGuestAgents
  };
}

export async function ensureTwinnyHomeDirectories(paths: RuntimePaths): Promise<void> {
  await Promise.all([
    fs.mkdir(paths.home, { recursive: true }),
    fs.mkdir(path.dirname(paths.ownerCodexHome), { recursive: true }),
    fs.mkdir(paths.guestCodexHome, { recursive: true }),
    fs.mkdir(paths.sqliteDir, { recursive: true }),
    fs.mkdir(paths.workspacesDir, { recursive: true }),
    fs.mkdir(paths.runtimeDir, { recursive: true })
  ]);
}

export async function ensureOwnerCodexSymlink(linkPath: string, targetPath: string): Promise<boolean> {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  try {
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${linkPath} exists and is not a symlink`);
    }

    const currentTarget = await fs.readlink(linkPath);
    const resolvedCurrent = path.resolve(path.dirname(linkPath), currentTarget);
    if (resolvedCurrent !== path.resolve(targetPath)) {
      throw new Error(`${linkPath} points to ${currentTarget}, expected ${targetPath}`);
    }
    return false;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }

  await fs.symlink(targetPath, linkPath, "dir");
  return true;
}

export async function ensureGuestAuthSymlink(linkPath: string, targetPath: string): Promise<boolean> {
  return ensureSymlink(linkPath, targetPath, "file");
}

export async function ensureGuestSessionsSymlink(linkPath: string, targetPath: string): Promise<boolean> {
  await fs.mkdir(targetPath, { recursive: true });
  return ensureSymlink(linkPath, targetPath, "dir");
}

async function ensureSymlink(linkPath: string, targetPath: string, type: "file" | "dir"): Promise<boolean> {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  try {
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${linkPath} exists and is not a symlink`);
    }

    const currentTarget = await fs.readlink(linkPath);
    const resolvedCurrent = path.resolve(path.dirname(linkPath), currentTarget);
    if (resolvedCurrent !== path.resolve(targetPath)) {
      throw new Error(`${linkPath} points to ${currentTarget}, expected ${targetPath}`);
    }
    return false;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }

  await fs.symlink(targetPath, linkPath, type);
  return true;
}

async function writeFileIfChanged(filePath: string, content: string): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === content) {
      return false;
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
  await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  return true;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
