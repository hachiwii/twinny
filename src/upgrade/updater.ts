import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execa } from "execa";
import { createRuntimePaths } from "../config/paths.js";
import {
  launchAgentLabelForHomeRandom,
  launchAgentPlistPathForLabel,
  launchAgentUsesEntrypoint,
  launchDaemonPlistPathForLabel
} from "../launchd/plist.js";
import { twinnyRunnerBinaryPath, twinnyRunnerDir } from "../platform/runner.js";
import { resolveManagedServiceKind, type ManagedServiceKind } from "../service/index.js";
import { systemdUserServicePathForHomeRandom } from "../systemd/install.js";
import { systemdUnitNameForHomeRandom } from "../systemd/unit.js";
import type { TwinnyConfig, UpgradeChannel } from "../types.js";
import { windowsTaskNameForHomeRandom, windowsTaskUsesEntrypoint } from "../windows/task.js";
import { compareTwinnyVersions, isExpectedTwinnyVersion, upgradeTagForChannel } from "./version.js";

type CommandRunner = typeof execa;

const DEFAULT_PACKAGE_NAME = "twinny";
const DEFAULT_STARTUP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_HELPER_DELAY_MS = 1_500;

export type TwinnyUpgradeDisabledReason =
  | "invalid-current-version"
  | "invalid-candidate-version"
  | "missing-dist-tag";

export interface TwinnyUpgradeCheckResult {
  currentVersion: string;
  currentVersionValid: boolean;
  channel: UpgradeChannel;
  tag: "latest" | "beta";
  registry?: string;
  packageName: string;
  candidateVersion?: string;
  candidateVersionValid: boolean;
  candidatePublishTime?: string;
  changelogUrl?: string;
  updateAvailable: boolean;
  comparison?: number;
  disabledReason?: TwinnyUpgradeDisabledReason;
}

export type TwinnyUpgradeScheduleResult =
  | { kind: "disabled"; check: TwinnyUpgradeCheckResult }
  | { kind: "no_update"; check: TwinnyUpgradeCheckResult }
  | {
      kind: "scheduled";
      check: TwinnyUpgradeCheckResult;
      targetVersion: string;
      preparedRunnerDir: string;
      helperScriptFile: string;
      helperLogFile: string;
    };

export interface TwinnyServiceRestartScheduleResult {
  kind: "scheduled";
  helperScriptFile: string;
  helperLogFile: string;
}

export interface CheckTwinnyUpgradeOptions {
  currentVersion: string;
  channel: UpgradeChannel;
  registry?: string;
  packageName?: string;
  runCommand?: CommandRunner;
}

export interface PrepareTwinnyUpgradeOptions extends CheckTwinnyUpgradeOptions {
  config: TwinnyConfig;
  platform?: NodeJS.Platform;
  startupTimeoutMs?: number;
  helperDelayMs?: number;
  spawnHelper?: boolean;
  verifyManagedServiceUsesRunner?: boolean;
}

export interface ScheduleTwinnyServiceRestartOptions {
  config: TwinnyConfig;
  platform?: NodeJS.Platform;
  startupTimeoutMs?: number;
  helperDelayMs?: number;
  expectedVersion?: string;
  spawnHelper?: boolean;
}

interface NpmPackageMetadata {
  distTags: Record<string, string>;
  time: Record<string, string>;
}

interface HelperPayload {
  action: "restart" | "upgrade";
  home: string;
  runnerDir: string;
  runnerBinary: string;
  preparedRunnerDir?: string;
  sqliteDir: string;
  runtimeDir: string;
  lockFile: string;
  statusFile: string;
  sentinelFile: string;
  backupDir: string;
  targetVersion?: string;
  expectedVersion?: string;
  service: HelperServicePayload;
  initialDelayMs: number;
  startupTimeoutMs: number;
  logFile: string;
}

type HelperServicePayload =
  | {
      kind: "launchd";
      mode: "gui" | "daemon";
      label: string;
      plistPath: string;
      launchctlDomain: string;
      launchctlTarget: string;
    }
  | { kind: "systemd"; unitName: string }
  | { kind: "windows-task"; taskName: string };

export async function checkForTwinnyUpgrade(options: CheckTwinnyUpgradeOptions): Promise<TwinnyUpgradeCheckResult> {
  const packageName = options.packageName ?? DEFAULT_PACKAGE_NAME;
  const tag = upgradeTagForChannel(options.channel);
  const metadata = await readNpmPackageMetadata({
    packageName,
    registry: options.registry,
    runCommand: options.runCommand ?? execa
  });
  const candidateVersion = metadata.distTags[tag];
  const currentVersionValid = isExpectedTwinnyVersion(options.currentVersion);
  const candidateVersionValid = candidateVersion ? isExpectedTwinnyVersion(candidateVersion) : false;
  const base = {
    currentVersion: options.currentVersion,
    currentVersionValid,
    channel: options.channel,
    tag,
    ...(options.registry ? { registry: options.registry } : {}),
    packageName,
    ...(candidateVersion ? {
      candidateVersion,
      candidatePublishTime: metadata.time[candidateVersion],
      changelogUrl: twinnyChangelogUrl(candidateVersion)
    } : {}),
    candidateVersionValid
  };
  if (!candidateVersion) {
    return { ...base, updateAvailable: false, disabledReason: "missing-dist-tag" };
  }
  if (!currentVersionValid) {
    return { ...base, updateAvailable: false, disabledReason: "invalid-current-version" };
  }
  if (!candidateVersionValid) {
    return { ...base, updateAvailable: false, disabledReason: "invalid-candidate-version" };
  }
  const comparison = compareTwinnyVersions(candidateVersion, options.currentVersion);
  return {
    ...base,
    updateAvailable: comparison !== undefined && comparison > 0,
    ...(comparison !== undefined ? { comparison } : {})
  };
}

export async function prepareAndScheduleTwinnyUpgrade(
  options: PrepareTwinnyUpgradeOptions
): Promise<TwinnyUpgradeScheduleResult> {
  const check = await checkForTwinnyUpgrade(options);
  if (check.disabledReason) {
    return { kind: "disabled", check };
  }
  if (!check.updateAvailable || !check.candidateVersion) {
    return { kind: "no_update", check };
  }
  const paths = createRuntimePaths(options.config.home);
  const runId = createRunId(check.candidateVersion);
  const downloadDir = path.join(paths.runtimeDir, "upgrade", `download-${runId}`);
  const preparedRunnerDir = path.join(downloadDir, "runner");
  await fs.rm(downloadDir, { recursive: true, force: true });
  await fs.mkdir(downloadDir, { recursive: true });
  await installTwinnyRunner({
    runnerDir: preparedRunnerDir,
    packageSpec: `${check.packageName}@${check.candidateVersion}`,
    registry: options.registry,
    runCommand: options.runCommand ?? execa
  });
  const scheduled = await scheduleHelper({
    action: "upgrade",
    config: options.config,
    platform: options.platform,
    preparedRunnerDir,
    targetVersion: check.candidateVersion,
    expectedVersion: check.candidateVersion,
    runId,
    startupTimeoutMs: options.startupTimeoutMs,
    helperDelayMs: options.helperDelayMs,
    spawnHelper: options.spawnHelper,
    verifyManagedServiceUsesRunner: options.verifyManagedServiceUsesRunner
  });
  return {
    kind: "scheduled",
    check,
    targetVersion: check.candidateVersion,
    preparedRunnerDir,
    helperScriptFile: scheduled.helperScriptFile,
    helperLogFile: scheduled.helperLogFile
  };
}

export async function scheduleTwinnyServiceRestart(
  options: ScheduleTwinnyServiceRestartOptions
): Promise<TwinnyServiceRestartScheduleResult> {
  const runId = createRunId("restart");
  return {
    kind: "scheduled",
    ...(await scheduleHelper({
      action: "restart",
      config: options.config,
      platform: options.platform,
      expectedVersion: options.expectedVersion,
      runId,
      startupTimeoutMs: options.startupTimeoutMs,
      helperDelayMs: options.helperDelayMs,
      spawnHelper: options.spawnHelper
    }))
  };
}

export function twinnyChangelogUrl(version: string): string {
  return `https://github.com/hachiwii/twinny/blob/v${encodeURIComponent(version)}/CHANGELOG.md`;
}

async function readNpmPackageMetadata(options: {
  packageName: string;
  registry?: string;
  runCommand: CommandRunner;
}): Promise<NpmPackageMetadata> {
  const args = ["view", options.packageName, "dist-tags", "time", "versions", "--json"];
  if (options.registry) {
    args.push("--registry", options.registry);
  }
  let stdout: string;
  try {
    const result = await options.runCommand("npm", args, { stdio: "pipe" });
    stdout = String(result.stdout ?? "");
  } catch (error) {
    throw new Error(errorOutput(error) || `failed to query npm metadata for ${options.packageName}`, { cause: error });
  }
  const parsed = parseNpmJson(stdout);
  const distTags = objectStringMap(readRecordValue(parsed, ["dist-tags", "distTags"]));
  const time = objectStringMap(readRecordValue(parsed, ["time"]));
  return { distTags, time };
}

async function installTwinnyRunner(options: {
  runnerDir: string;
  packageSpec: string;
  registry?: string;
  runCommand: CommandRunner;
}): Promise<void> {
  const args = ["install", "--prefix", options.runnerDir, "--omit=dev", "--no-audit", "--no-fund", options.packageSpec];
  if (options.registry) {
    args.push("--registry", options.registry);
  }
  try {
    await options.runCommand("npm", args, { stdio: "pipe" });
  } catch (error) {
    throw new Error(errorOutput(error) || `failed to download ${options.packageSpec}`, { cause: error });
  }
}

async function scheduleHelper(options: {
  action: "restart" | "upgrade";
  config: TwinnyConfig;
  platform?: NodeJS.Platform;
  preparedRunnerDir?: string;
  targetVersion?: string;
  expectedVersion?: string;
  runId: string;
  startupTimeoutMs?: number;
  helperDelayMs?: number;
  spawnHelper?: boolean;
  verifyManagedServiceUsesRunner?: boolean;
}): Promise<{ helperScriptFile: string; helperLogFile: string }> {
  const paths = createRuntimePaths(options.config.home);
  const service = await helperServicePayload(options.config, options.platform ?? process.platform);
  const runnerBinary = twinnyRunnerBinaryPath(paths.home, options.platform ?? process.platform);
  if (options.action === "upgrade" && options.verifyManagedServiceUsesRunner !== false) {
    const usesRunner = await currentServiceUsesRunner({
      config: options.config,
      home: paths.home,
      runnerBinary,
      service
    });
    if (!usesRunner) {
      throw new Error("当前托管服务没有使用 Twinny runner，无法通过 /upgrade 安全替换。请先用 `twinny install` 以 runner 方式安装。");
    }
  }
  const helperDir = path.join(paths.runtimeDir, "upgrade");
  const helperScriptFile = path.join(helperDir, `${options.action}-${options.runId}.mjs`);
  const helperLogFile = path.join(paths.logsDir, `twinny-${options.action}-${options.runId}.log`);
  const payload: HelperPayload = {
    action: options.action,
    home: paths.home,
    runnerDir: twinnyRunnerDir(paths.home),
    runnerBinary,
    ...(options.preparedRunnerDir ? { preparedRunnerDir: options.preparedRunnerDir } : {}),
    sqliteDir: paths.sqliteDir,
    runtimeDir: paths.runtimeDir,
    lockFile: paths.lockFile,
    statusFile: paths.statusFile,
    sentinelFile: path.join(paths.runtimeDir, "upgrade-in-progress"),
    backupDir: path.join(helperDir, `backup-${options.runId}`),
    ...(options.targetVersion ? { targetVersion: options.targetVersion } : {}),
    ...(options.expectedVersion ? { expectedVersion: options.expectedVersion } : {}),
    service,
    initialDelayMs: options.helperDelayMs ?? DEFAULT_HELPER_DELAY_MS,
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    logFile: helperLogFile
  };
  await fs.mkdir(helperDir, { recursive: true });
  await fs.mkdir(path.dirname(helperLogFile), { recursive: true });
  await fs.writeFile(helperScriptFile, createHelperScript(payload), { encoding: "utf8", mode: 0o700 });
  await appendHelperLog(helperLogFile, `scheduled ${options.action} helper: ${helperScriptFile}`);
  if (options.spawnHelper !== false) {
    const child = spawn(process.execPath, [helperScriptFile], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, TWINNY_HOME: paths.home }
    });
    child.unref();
  }
  return { helperScriptFile, helperLogFile };
}

async function currentServiceUsesRunner(input: {
  config: TwinnyConfig;
  home: string;
  runnerBinary: string;
  service: HelperServicePayload;
}): Promise<boolean> {
  if (input.service.kind === "launchd") {
    let plist: string;
    try {
      plist = await fs.readFile(input.service.plistPath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
    return launchAgentUsesEntrypoint(plist, input.runnerBinary);
  }
  if (input.service.kind === "systemd") {
    const servicePath = systemdUserServicePathForHomeRandom(input.config.homeIdentity.random);
    return textFileIncludes(servicePath, input.runnerBinary);
  }
  return windowsTaskUsesEntrypoint({
    home: input.home,
    entrypoint: input.runnerBinary
  });
}

async function textFileIncludes(filePath: string, expected: string): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  return content.includes(path.resolve(expected));
}

async function helperServicePayload(config: TwinnyConfig, platform: NodeJS.Platform): Promise<HelperServicePayload> {
  const kind = await resolveManagedServiceKind({ platform });
  if (kind === "manual") {
    throw new Error("当前运行环境不支持托管服务重启/升级；请使用 launchd、systemd user service 或 Windows Task Scheduler。");
  }
  if (kind === "launchd") {
    const label = launchAgentLabelForHomeRandom(config.homeIdentity.random);
    const mode = config.service.launchd.mode;
    const uid = process.getuid?.();
    const launchctlDomain = mode === "daemon" ? "system" : `gui/${uid ?? ""}`;
    return {
      kind,
      mode,
      label,
      plistPath: mode === "daemon" ? launchDaemonPlistPathForLabel(label) : launchAgentPlistPathForLabel(label),
      launchctlDomain,
      launchctlTarget: `${launchctlDomain}/${label}`
    };
  }
  if (kind === "systemd") {
    return { kind, unitName: systemdUnitNameForHomeRandom(config.homeIdentity.random) };
  }
  return { kind: "windows-task", taskName: windowsTaskNameForHomeRandom(config.homeIdentity.random) };
}

function createHelperScript(payload: HelperPayload): string {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const payload = ${JSON.stringify(payload, null, 2)};

main().catch(async (error) => {
  log("helper failed: " + errorMessage(error));
  if (payload.action === "upgrade") {
    await rollbackUpgrade().catch((rollbackError) => {
      log("rollback failed: " + errorMessage(rollbackError));
    });
  }
  process.exit(1);
});

async function main() {
  await sleep(payload.initialDelayMs);
  log("helper started: " + payload.action);
  if (payload.action === "upgrade") {
    await applyUpgrade();
    return;
  }
  await restartRuntime();
}

async function applyUpgrade() {
  if (!payload.preparedRunnerDir || !payload.targetVersion) {
    throw new Error("upgrade helper is missing target runner information");
  }
  writeSentinel();
  await stopRuntime({ sentinel: true });
  backupSqlite();
  backupRunner();
  replaceRunner();
  await startRuntime();
  const ok = await waitForRuntimeHealthy(payload.expectedVersion, payload.startupTimeoutMs);
  if (!ok) {
    throw new Error("new Twinny version did not become healthy within " + payload.startupTimeoutMs + "ms");
  }
  log("upgrade completed: " + payload.targetVersion);
}

async function rollbackUpgrade() {
  log("starting rollback");
  writeSentinel();
  await stopRuntime({ sentinel: true });
  restoreRunner();
  restoreSqlite();
  await startRuntime();
  const ok = await waitForRuntimeHealthy(undefined, payload.startupTimeoutMs);
  log(ok ? "rollback completed" : "rollback started old runner but health check timed out");
}

async function restartRuntime() {
  await stopRuntime({ sentinel: false });
  await startRuntime();
  const ok = await waitForRuntimeHealthy(payload.expectedVersion, payload.startupTimeoutMs);
  if (!ok) {
    throw new Error("Twinny did not restart within " + payload.startupTimeoutMs + "ms");
  }
  log("restart completed");
}

async function stopRuntime(options) {
  if (options.sentinel) {
    writeSentinel();
  }
  const pid = readLockPid();
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      log("sent SIGTERM to pid " + pid);
    } catch (error) {
      log("failed to signal pid " + pid + ": " + errorMessage(error));
    }
  }
  if (payload.service.kind === "windows-task") {
    await runBestEffort("schtasks", ["/End", "/TN", payload.service.taskName]);
  } else if (payload.service.kind === "systemd" && !options.sentinel) {
    await runBestEffort("systemctl", ["--user", "stop", payload.service.unitName]);
  } else if (payload.service.kind === "launchd" && payload.service.mode === "gui" && !options.sentinel) {
    await runBestEffort("launchctl", ["bootout", payload.service.launchctlDomain, payload.service.plistPath]);
  }
  await waitForLockReleased(120000);
}

async function startRuntime() {
  removeSentinel();
  if (payload.service.kind === "windows-task") {
    await runBestEffort("schtasks", ["/Run", "/TN", payload.service.taskName]);
    return;
  }
  if (payload.service.kind === "systemd") {
    await runBestEffort("systemctl", ["--user", "start", payload.service.unitName]);
    return;
  }
  if (payload.service.mode === "gui") {
    await runBestEffort("launchctl", ["bootstrap", payload.service.launchctlDomain, payload.service.plistPath]);
    await runBestEffort("launchctl", ["kickstart", "-k", payload.service.launchctlTarget]);
    return;
  }
  await runBestEffort("sudo", ["-n", "launchctl", "kickstart", "-k", payload.service.launchctlTarget]);
}

function backupSqlite() {
  const backup = path.join(payload.backupDir, "sqlite");
  fs.rmSync(backup, { recursive: true, force: true });
  if (!fs.existsSync(payload.sqliteDir)) {
    log("sqlite dir missing; skipped backup");
    return;
  }
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.cpSync(payload.sqliteDir, backup, { recursive: true, preserveTimestamps: true });
  log("backed up sqlite dir to " + backup);
}

function backupRunner() {
  const backup = path.join(payload.backupDir, "runner");
  fs.rmSync(backup, { recursive: true, force: true });
  if (!fs.existsSync(payload.runnerDir)) {
    throw new Error("runner dir is missing: " + payload.runnerDir);
  }
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.renameSync(payload.runnerDir, backup);
  log("moved current runner to " + backup);
}

function replaceRunner() {
  if (!fs.existsSync(payload.preparedRunnerDir)) {
    throw new Error("prepared runner dir is missing: " + payload.preparedRunnerDir);
  }
  fs.renameSync(payload.preparedRunnerDir, payload.runnerDir);
  log("installed prepared runner " + payload.runnerDir);
}

function restoreRunner() {
  const backup = path.join(payload.backupDir, "runner");
  if (!fs.existsSync(backup)) {
    log("runner backup missing; skipped runner restore");
    return;
  }
  fs.rmSync(payload.runnerDir, { recursive: true, force: true });
  fs.renameSync(backup, payload.runnerDir);
  log("restored runner backup");
}

function restoreSqlite() {
  const backup = path.join(payload.backupDir, "sqlite");
  if (!fs.existsSync(backup)) {
    log("sqlite backup missing; skipped sqlite restore");
    return;
  }
  fs.rmSync(payload.sqliteDir, { recursive: true, force: true });
  fs.cpSync(backup, payload.sqliteDir, { recursive: true, preserveTimestamps: true });
  log("restored sqlite backup");
}

function writeSentinel() {
  fs.mkdirSync(path.dirname(payload.sentinelFile), { recursive: true });
  fs.writeFileSync(payload.sentinelFile, JSON.stringify({ pid: process.pid, action: payload.action, startedAt: Date.now() }) + "\\n");
}

function removeSentinel() {
  fs.rmSync(payload.sentinelFile, { force: true });
}

async function waitForLockReleased(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!lockLooksActive()) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function waitForRuntimeHealthy(expectedVersion, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readRuntimeStatus();
    if (lockLooksActive() && (!expectedVersion || status?.version === expectedVersion)) {
      return true;
    }
    await sleep(1000);
  }
  return false;
}

function lockLooksActive() {
  const pid = readLockPid();
  if (pid) {
    return processIsAlive(pid);
  }
  return fs.existsSync(payload.lockFile + ".lock");
}

function readLockPid() {
  try {
    const raw = fs.readFileSync(payload.lockFile, "utf8").trim();
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw);
    return typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

function readRuntimeStatus() {
  try {
    const parsed = JSON.parse(fs.readFileSync(payload.statusFile, "utf8"));
    if (typeof parsed.pid === "number" && !processIsAlive(parsed.pid)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ exitCode: 1, stdout, stderr: errorMessage(error) }));
    child.on("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}

async function runBestEffort(command, args) {
  const result = await run(command, args);
  log("$ " + [command, ...args].join(" ") + " -> " + result.exitCode);
  const output = [result.stdout, result.stderr].filter((item) => item && item.trim()).join("\\n").trim();
  if (output) {
    log(output);
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  fs.mkdirSync(path.dirname(payload.logFile), { recursive: true });
  fs.appendFileSync(payload.logFile, "[" + new Date().toISOString() + "] " + message + "\\n");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
`;
}

function parseNpmJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error("failed to parse npm metadata JSON", { cause: error });
  }
}

function readRecordValue(input: unknown, keys: string[]): unknown {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function objectStringMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(input)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function createRunId(label: string): string {
  return `${label.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function appendHelperLog(file: string, message: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(file, { flags: "a" });
    stream.once("error", reject);
    stream.end(`[${new Date().toISOString()}] ${message}\n`, () => resolve());
  });
}

function errorOutput(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const record = error as { shortMessage?: unknown; stderr?: unknown; stdout?: unknown };
  return [record.shortMessage, record.stderr, record.stdout]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .filter((value, index, values) => values.indexOf(value) === index)
    .join("\n");
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
