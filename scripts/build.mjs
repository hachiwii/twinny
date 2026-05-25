#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function main() {
  const cliVersion = parseVersionArg(process.argv.slice(2));
  const buildVersion = cliVersion ?? process.env.TWINNY_BUILD_VERSION ?? readPackageVersion(repoRoot);

  validateBuildVersion(buildVersion);
  cleanDist();
  run("tsc", ["-p", "tsconfig.build.json"]);
  writeDistVersion(buildVersion);
  console.log(`Injected Twinny version ${buildVersion} into dist/version.js`);
}

function parseVersionArg(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--version") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value after --version");
      }
      return value;
    }
    if (arg.startsWith("--version=")) {
      return arg.slice("--version=".length);
    }
    throw new Error(`Unknown build argument "${arg}". Use --version <value> for release builds.`);
  }
  return undefined;
}

function readPackageVersion(cwd) {
  const packageJson = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string") {
    throw new Error("Missing package.json version");
  }
  return packageJson.version;
}

function validateBuildVersion(version) {
  if (!/^[A-Za-z0-9._+-]+$/.test(version)) {
    throw new Error(`Invalid Twinny version "${version}". Use letters, numbers, dots, underscores, plus signs, or hyphens.`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function cleanDist() {
  rmSync(path.join(repoRoot, "dist"), { recursive: true, force: true });
}

function writeDistVersion(version) {
  const distDir = path.join(repoRoot, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(path.join(distDir, "version.js"), `export const TWINNY_VERSION = ${JSON.stringify(version)};\n`);
  writeFileSync(path.join(distDir, "version.d.ts"), "export declare const TWINNY_VERSION: string;\n");
  writeFileSync(path.join(distDir, "version.json"), `${JSON.stringify({ version }, null, 2)}\n`);
}
