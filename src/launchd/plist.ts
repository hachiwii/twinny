import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const legacyLaunchAgentLabel = "com.twinny.daemon";
export const launchAgentLabelPrefix = "com.twinny.daemon";

export interface CreateLaunchAgentPlistOptions {
  label?: string;
  entrypoint?: string;
  twinnyHome?: string;
  userName?: string;
  environment?: Record<string, string | undefined>;
}

export function createLaunchAgentPlist(options: CreateLaunchAgentPlistOptions = {}): string {
  const label = options.label ?? legacyLaunchAgentLabel;
  const entrypoint = options.entrypoint ? path.resolve(options.entrypoint) : process.argv[1] ? path.resolve(process.argv[1]) : process.execPath;
  const logsDir = path.join(os.homedir(), "Library", "Logs", "twinny");
  const stdout = path.join(logsDir, `${label}.log`);
  const twinnyHome = options.twinnyHome ?? process.env.TWINNY_HOME ?? path.join(os.homedir(), ".twinny");
  const args = entrypoint === process.execPath ? [process.execPath, "run"] : [process.execPath, entrypoint, "run"];
  const userNameEntry = options.userName ? `  <key>UserName</key>\n  <string>${escapeXml(options.userName)}</string>\n` : "";
  const environment = normalizeEnvironment({
    ...(options.environment ?? {}),
    TWINNY_HOME: twinnyHome
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
${userNameEntry}  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment).map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stdout)}</string>
</dict>
</plist>
`;
}

export function launchAgentLabelForHomeRandom(homeRandom: string): string {
  const homeId = createHash("sha256").update(homeRandom.trim().toLowerCase()).digest("hex").slice(0, 16);
  return `${launchAgentLabelPrefix}.${homeId}`;
}

export function launchAgentPlistPathForLabel(label: string, homeDir = os.homedir()): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
}

export function launchDaemonPlistPathForLabel(label: string): string {
  return path.join("/Library", "LaunchDaemons", `${label}.plist`);
}

export function launchAgentProgramArguments(plist: string): string[] {
  const match = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((item) => unescapeXml(item[1] ?? ""));
}

export function launchAgentUsesEntrypoint(plist: string, entrypoint: string): boolean {
  const resolved = path.resolve(entrypoint);
  return launchAgentProgramArguments(plist).some((arg) => path.resolve(arg) === resolved);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function normalizeEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment)
      .filter(([key, value]) => key.trim() && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)])
  );
}
