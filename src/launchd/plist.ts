import os from "node:os";
import path from "node:path";

export const launchAgentLabel = "com.twinny.daemon";

export function createLaunchAgentPlist(): string {
  const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : process.execPath;
  const logsDir = path.join(os.homedir(), "Library", "Logs", "twinny");
  const stdout = path.join(logsDir, "daemon.log");
  const stderr = path.join(logsDir, "daemon.error.log");
  const twinnyHome = process.env.TWINNY_HOME ?? path.join(os.homedir(), ".twinny");
  const args = entrypoint === process.execPath ? [process.execPath, "run"] : [process.execPath, entrypoint, "run"];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(launchAgentLabel)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TWINNY_HOME</key>
    <string>${escapeXml(twinnyHome)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderr)}</string>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
