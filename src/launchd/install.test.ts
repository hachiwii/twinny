import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireTwinnyLock } from "../lock/index.js";
import { waitForRuntimeLockRelease } from "./install.js";

describe("launchd install helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-launchd-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("waits until the runtime lock is released", async () => {
    const lock = await acquireTwinnyLock(tempDir, { retries: 0 });
    const waiting = waitForRuntimeLockRelease({ home: tempDir, timeoutMs: 1000, pollMs: 5 });

    setTimeout(() => {
      void lock.release();
    }, 20);

    await expect(waiting).resolves.toBeUndefined();
  });

  it("times out while the runtime lock is still held", async () => {
    const lock = await acquireTwinnyLock(tempDir, { retries: 0 });
    try {
      await expect(waitForRuntimeLockRelease({ home: tempDir, timeoutMs: 20, pollMs: 5 })).rejects.toThrow(
        /Timed out waiting for Twinny runtime lock/
      );
    } finally {
      await lock.release();
    }
  });
});
