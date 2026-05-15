import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireTwinnyLock, getTwinnyLockFile, isTwinnyLockHeld, readTwinnyLockPid } from "./index.js";

describe("runtime lock", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-lock-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("locks TWINNY_HOME/runtime/twinny.lock with readable pid metadata", async () => {
    const lock = await acquireTwinnyLock(tempDir, { retries: 0 });
    try {
      expect(lock.lockFile).toBe(getTwinnyLockFile(tempDir));
      expect(lock.lockFile).toBe(path.join(tempDir, "runtime", "twinny.lock"));
      expect(await isTwinnyLockHeld(tempDir)).toBe(true);
      expect(await readTwinnyLockPid(tempDir)).toBe(process.pid);
      await expect(acquireTwinnyLock(tempDir, { retries: 0 })).rejects.toThrow();
    } finally {
      await lock.release();
    }

    expect(await isTwinnyLockHeld(tempDir)).toBe(false);
    expect(await readTwinnyLockPid(tempDir)).toBeUndefined();
  });

  it("allows idempotent release", async () => {
    const lock = await acquireTwinnyLock(tempDir, { retries: 0 });
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
