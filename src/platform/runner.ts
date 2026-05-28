import path from "node:path";
import { npmBinNameForPlatform } from "./commands.js";

export function twinnyRunnerDir(home: string): string {
  return path.join(home, "runner");
}

export function twinnyRunnerBinaryPath(home: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(twinnyRunnerDir(home), "node_modules", ".bin", npmBinNameForPlatform("twinny", platform));
}
