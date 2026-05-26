import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const systemdUnitNamePrefix = "twinny";

export interface CreateSystemdUserServiceUnitOptions {
  unitName?: string;
  entrypoint?: string;
  twinnyHome?: string;
  environment?: Record<string, string | undefined>;
}

export function createSystemdUserServiceUnit(options: CreateSystemdUserServiceUnitOptions = {}): string {
  const unitName = options.unitName ?? `${systemdUnitNamePrefix}.service`;
  const entrypoint = options.entrypoint ? path.resolve(options.entrypoint) : process.argv[1] ? path.resolve(process.argv[1]) : process.execPath;
  const twinnyHome = options.twinnyHome ?? process.env.TWINNY_HOME ?? path.join(os.homedir(), ".twinny");
  const args = entrypoint === process.execPath ? [process.execPath, "run"] : [process.execPath, entrypoint, "run"];
  const environment = normalizeEnvironment({
    ...(options.environment ?? {}),
    TWINNY_HOME: twinnyHome
  });

  return `[Unit]
Description=Twinny daemon (${escapeSystemdText(unitName)})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${escapeSystemdPath(twinnyHome)}
ExecStart=${args.map(quoteSystemd).join(" ")}
Restart=always
RestartSec=5
${Object.keys(environment).length > 0 ? `Environment=${Object.entries(environment).map(([key, value]) => quoteSystemd(`${key}=${value}`)).join(" ")}\n` : ""}StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

export function systemdUnitNameForHomeRandom(homeRandom: string): string {
  const homeId = createHash("sha256").update(homeRandom.trim().toLowerCase()).digest("hex").slice(0, 16);
  return `${systemdUnitNamePrefix}-${homeId}.service`;
}

function normalizeEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment)
      .filter(([key, value]) => isSystemdEnvironmentKey(key) && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)])
  );
}

function isSystemdEnvironmentKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function quoteSystemd(value: string): string {
  return `"${escapeSystemdText(value)}"`;
}

function escapeSystemdPath(value: string): string {
  return value.replaceAll("%", "%%");
}

function escapeSystemdText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$$$");
}
