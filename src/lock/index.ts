import fs from "node:fs/promises";
import path from "node:path";

import * as properLockfile from "proper-lockfile";
import type { CheckOptions, LockOptions } from "proper-lockfile";

import type { RuntimePaths } from "../types.js";

export interface TwinnyLockMetadata {
  pid: number;
  acquiredAt: number;
}

export interface TwinnyRuntimeLock {
  lockFile: string;
  metadata: TwinnyLockMetadata;
  release: () => Promise<void>;
}

export interface AcquireTwinnyLockOptions extends Pick<LockOptions, "stale" | "update" | "retries" | "onCompromised"> {
}

export interface CheckTwinnyLockOptions extends Pick<CheckOptions, "stale"> {
}

export function getTwinnyLockFile(twinnyHome: string): string {
  return path.join(twinnyHome, "runtime", "twinny.lock");
}

export async function acquireTwinnyLock(
  target: string | Pick<RuntimePaths, "lockFile">,
  options: AcquireTwinnyLockOptions = {}
): Promise<TwinnyRuntimeLock> {
  const lockFile = resolveLockFile(target);
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  await fs.appendFile(lockFile, "");

  const releaseProperLock = await properLockfile.lock(lockFile, {
    ...options,
    realpath: false
  });
  const metadata = { pid: process.pid, acquiredAt: Date.now() };
  let released = false;

  await fs.writeFile(lockFile, `${JSON.stringify(metadata)}\n`, "utf8");

  return {
    lockFile,
    metadata,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      await fs.writeFile(lockFile, "", "utf8");
      await releaseProperLock();
    }
  };
}

export async function isTwinnyLockHeld(
  target: string | Pick<RuntimePaths, "lockFile">,
  options: CheckTwinnyLockOptions = {}
): Promise<boolean> {
  const lockFile = resolveLockFile(target);
  try {
    return await properLockfile.check(lockFile, {
      ...options,
      realpath: false
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readTwinnyLockMetadata(
  target: string | Pick<RuntimePaths, "lockFile">,
  options: CheckTwinnyLockOptions = {}
): Promise<TwinnyLockMetadata | undefined> {
  const lockFile = resolveLockFile(target);
  const held = await isTwinnyLockHeld({ lockFile }, options);
  if (!held) {
    return undefined;
  }

  const raw = await fs.readFile(lockFile, "utf8");
  if (raw.trim() === "") {
    return undefined;
  }

  const parsed = JSON.parse(raw) as Partial<TwinnyLockMetadata>;
  if (typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "number") {
    return undefined;
  }
  return {
    pid: parsed.pid,
    acquiredAt: parsed.acquiredAt
  };
}

export async function readTwinnyLockPid(
  target: string | Pick<RuntimePaths, "lockFile">,
  options: CheckTwinnyLockOptions = {}
): Promise<number | undefined> {
  return (await readTwinnyLockMetadata(target, options))?.pid;
}

function resolveLockFile(target: string | Pick<RuntimePaths, "lockFile">): string {
  if (typeof target === "string") {
    return getTwinnyLockFile(target);
  }
  return target.lockFile;
}
