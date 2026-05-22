import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimePaths, TwinnyConfig } from "../types.js";
import { createRuntimePaths } from "./paths.js";
import { writeTwinnyAuthFile, writeTwinnyConfig, writeTwinnyHomeRandom } from "./loader.js";

export interface BootstrapTwinnyHomeOptions {
  overwriteConfig?: boolean;
  overwriteAuth?: boolean;
}

export interface BootstrapTwinnyHomeResult {
  paths: RuntimePaths;
  wroteConfig: boolean;
  wroteAuth: boolean;
  wroteHomeRandom: boolean;
}

export function generateTwinnyHomeRandom(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export async function bootstrapTwinnyHome(
  config: TwinnyConfig,
  options: BootstrapTwinnyHomeOptions = {}
): Promise<BootstrapTwinnyHomeResult> {
  const paths = createRuntimePaths(config.home);
  await ensureTwinnyHomeDirectories(paths);

  let wroteHomeRandom = false;
  if (!(await pathExists(paths.homeRandomFile))) {
    await writeTwinnyHomeRandom(config.homeIdentity.random, paths.homeRandomFile);
    wroteHomeRandom = true;
  }

  let wroteAuth = false;
  if (options.overwriteAuth || !(await pathExists(paths.authFile))) {
    await writeTwinnyAuthFile(config.auth, paths.authFile);
    wroteAuth = true;
  }

  let wroteConfig = false;
  if (options.overwriteConfig || !(await pathExists(paths.configFile))) {
    await writeTwinnyConfig(config, paths.configFile);
    wroteConfig = true;
  }

  return {
    paths,
    wroteConfig,
    wroteAuth,
    wroteHomeRandom
  };
}

export async function ensureTwinnyHomeDirectories(paths: RuntimePaths): Promise<void> {
  await Promise.all([
    fs.mkdir(paths.home, { recursive: true }),
    fs.mkdir(paths.sqliteDir, { recursive: true }),
    fs.mkdir(paths.workspacesDir, { recursive: true }),
    fs.mkdir(paths.runtimeDir, { recursive: true })
  ]);
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
