import fs from "node:fs/promises";
import { execa } from "execa";

type CommandRunner = typeof execa;

export interface PlatformDetectionOptions {
  platform?: NodeJS.Platform;
  readFile?: typeof fs.readFile;
  runCommand?: CommandRunner;
}

export async function isWsl2(options: PlatformDetectionOptions = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return false;
  }
  const readFile = options.readFile ?? fs.readFile;
  const texts = await Promise.all([
    readTextBestEffort("/proc/sys/kernel/osrelease", readFile),
    readTextBestEffort("/proc/version", readFile)
  ]);
  return texts.some((text) => /\bmicrosoft\b|\bwsl2?\b/i.test(text));
}

export async function isSystemdUserAvailable(options: PlatformDetectionOptions = {}): Promise<boolean> {
  const runCommand = options.runCommand ?? execa;
  const result = await runCommand("systemctl", ["--user", "show-environment"], { reject: false });
  return result.exitCode === 0;
}

async function readTextBestEffort(filePath: string, readFile: typeof fs.readFile): Promise<string> {
  try {
    return String(await readFile(filePath, "utf8"));
  } catch {
    return "";
  }
}
