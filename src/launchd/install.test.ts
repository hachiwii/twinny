import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireTwinnyLock } from "../lock/index.js";
import { waitForRuntimeLockRelease } from "./install.js";
import { createLaunchAgentPlist, launchAgentLabelForHomeRandom } from "./plist.js";

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

  it("routes daemon stdout and stderr to the per-home daemon log", () => {
    const label = launchAgentLabelForHomeRandom("0123456789abcdef0123456789abcdef");
    const plist = createLaunchAgentPlist({ label });

    expect(plist.match(new RegExp(`${label}\\.log`, "g"))).toHaveLength(2);
    expect(plist).not.toContain("daemon.error.log");
  });

  it("derives stable launchd labels from home random without exposing the raw value", () => {
    const firstRandom = "0123456789abcdef0123456789abcdef";
    const secondRandom = "fedcba9876543210fedcba9876543210";

    expect(launchAgentLabelForHomeRandom(firstRandom)).toBe(launchAgentLabelForHomeRandom(firstRandom));
    expect(launchAgentLabelForHomeRandom(firstRandom)).not.toBe(launchAgentLabelForHomeRandom(secondRandom));
    expect(launchAgentLabelForHomeRandom(firstRandom)).not.toContain(firstRandom);
  });
});
