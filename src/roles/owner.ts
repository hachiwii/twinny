import os from "node:os";
import path from "node:path";

export function defaultOwnerCodexTarget(homeDir = os.homedir()): string {
  return path.join(homeDir, ".codex");
}

