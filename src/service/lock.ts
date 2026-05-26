import { createRuntimePaths, resolveTwinnyHome } from "../config/index.js";
import { isTwinnyLockHeld, readTwinnyLockPid } from "../lock/index.js";

const defaultStopWaitTimeoutMs = 35_000;
const defaultStopWaitPollMs = 250;
const runtimeLockStaleMs = 30_000;

export interface WaitForRuntimeLockReleaseOptions {
  home?: string;
  timeoutMs?: number;
  pollMs?: number;
}

export async function waitForRuntimeLockRelease(options: WaitForRuntimeLockReleaseOptions = {}): Promise<void> {
  const paths = createRuntimePaths(options.home ?? resolveTwinnyHome());
  const timeoutMs = options.timeoutMs ?? defaultStopWaitTimeoutMs;
  const pollMs = options.pollMs ?? defaultStopWaitPollMs;
  const deadline = Date.now() + timeoutMs;

  while (await isTwinnyLockHeld(paths, { stale: runtimeLockStaleMs })) {
    if (Date.now() >= deadline) {
      const pid = await readTwinnyLockPid(paths, { stale: runtimeLockStaleMs });
      const detail = pid ? `pid ${pid}` : "unknown pid";
      throw new Error(`Timed out waiting for Twinny runtime lock to release (${detail})`);
    }
    await sleep(pollMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
