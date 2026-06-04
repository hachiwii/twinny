import type { UpgradeChannel } from "../types.js";

export interface ParsedTwinnyVersion {
  major: number;
  minor: number;
  patch: number;
  suffix?: bigint;
}

const twinnyVersionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/;

export function parseTwinnyVersion(version: string): ParsedTwinnyVersion | undefined {
  const match = twinnyVersionPattern.exec(version.trim());
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return undefined;
  }
  return {
    major,
    minor,
    patch,
    ...(match[4] ? { suffix: BigInt(match[4]) } : {})
  };
}

export function isExpectedTwinnyVersion(version: string): boolean {
  return parseTwinnyVersion(version) !== undefined;
}

export function compareTwinnyVersions(left: string, right: string): number | undefined {
  const parsedLeft = parseTwinnyVersion(left);
  const parsedRight = parseTwinnyVersion(right);
  if (!parsedLeft || !parsedRight) {
    return undefined;
  }
  return compareParsedTwinnyVersions(parsedLeft, parsedRight);
}

export function compareParsedTwinnyVersions(left: ParsedTwinnyVersion, right: ParsedTwinnyVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    const delta = left[key] - right[key];
    if (delta !== 0) {
      return delta > 0 ? 1 : -1;
    }
  }
  if (left.suffix === undefined && right.suffix === undefined) {
    return 0;
  }
  if (left.suffix === undefined) {
    return 1;
  }
  if (right.suffix === undefined) {
    return -1;
  }
  if (left.suffix === right.suffix) {
    return 0;
  }
  return left.suffix > right.suffix ? 1 : -1;
}

export function upgradeTagForChannel(channel: UpgradeChannel): "latest" | "beta" {
  return channel === "beta" ? "beta" : "latest";
}
