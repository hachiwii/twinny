import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { execa } from "execa";
import { parse } from "smol-toml";
import {
  bootstrapTwinnyHome,
  createRuntimePaths,
  createTwinnyConfig,
  expandHomePath,
  generateTwinnyHomeRandom,
  resolveBundledBannerPath,
  resolveBundledLogoPath,
  resolveTwinnyHome,
  SecurityCliSecretStore,
  type SecretStore
} from "../config/index.js";
import { provisionLarkAssetImageKeys } from "../app/lark-assets.js";
import { installLaunchAgent, startLaunchAgent } from "../launchd/install.js";
import {
  buildLarkVerificationUrl,
  getLarkBrowserUserInfo,
  LarkFileDownloader,
  LarkOpenApiClient,
  LarkUserDirectory,
  pollLarkAppRegistration,
  pollLarkDeviceToken,
  requestLarkAppRegistration,
  requestLarkDeviceAuthorization,
  resolveLarkEndpoints,
  TenantAccessTokenManager
} from "../lark/index.js";
import { TWINNY_VERSION } from "../version.js";
import type { LarkBrand, TwinnyConfig } from "../types.js";

const minimumCodexVersion = "0.130.0";
export const installWizardLarkBrand: LarkBrand = "feishu";

const sensitiveEnvPattern = /(?:SECRET|TOKEN|PASSWORD|PASS|PWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|COOKIE|SESSION|CREDENTIAL|AUTH)/i;
const terminalEnvKeys = new Set([
  "_",
  "COLORTERM",
  "OLDPWD",
  "PWD",
  "SHLVL",
  "SSH_AUTH_SOCK",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "TMPDIR",
  "TTY"
]);

type BotChoice = "auto" | "manual";
type OwnerChoice = "browser" | "manual";

interface BotCredentials {
  appId: string;
  appSecret: string;
  brand: LarkBrand;
}

interface OwnerIdentity {
  openId: string;
  displayName: string;
}

interface CodexDetection {
  binary: string;
  version: string;
}

interface CodexDefaults {
  model: string;
  effort: string;
}

export async function runInstallWizard(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Twinny install wizard requires an interactive terminal. Run `twinny install` from a terminal.");
  }

  p.intro("Twinny install");
  const home = resolveInstallHome(process.env);
  await assertInstallHomeIsEmpty(home);
  const homeRandom = generateTwinnyHomeRandom();
  const codex = await detectCodexBinary();
  p.log.success(`Codex ${codex.version} (${codex.binary})`);

  const bot = await promptBotCredentials();
  const owner = await promptOwnerIdentity(bot);
  const environment = await promptLaunchEnvironment(home, process.env);
  const codexDefaults = await readCodexDefaults();
  p.log.info(`Host profile defaults: ${codexDefaults.model} / ${codexDefaults.effort}`);

  const config = createTwinnyConfig({
    home,
    homeRandom,
    codex: { binary: codex.binary },
    auth: {
      larkAppId: bot.appId,
      larkBrand: bot.brand,
      ownerOpenId: owner.openId,
      displayName: owner.displayName
    },
    profiles: {
      host: {
        defaultModel: codexDefaults.model,
        defaultEffort: codexDefaults.effort
      },
      guest: {}
    }
  });

  await finalizeInstall({ config, appSecret: bot.appSecret, environment });

  const shouldStart = await cancelable(
    p.confirm({
      message: "安装完成。现在启动 Twinny？",
      initialValue: true
    })
  );
  if (shouldStart) {
    const s = p.spinner();
    s.start("启动 Twinny");
    await startLaunchAgent({ home });
    s.stop("Twinny 已启动");
  } else {
    p.log.info(`稍后可执行：TWINNY_HOME=${shellQuote(home)} twinny start`);
  }
  p.outro("Twinny 安装完成");
}

export function resolveInstallHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolveTwinnyHome({ env });
}

export async function assertInstallHomeIsEmpty(home: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(home);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(`TWINNY_HOME must be a directory: ${home}`);
  }
  const entries = await fs.readdir(home);
  if (entries.length > 0) {
    throw new Error(`TWINNY_HOME is not empty: ${home}. Choose an empty directory and retry with TWINNY_HOME=/path twinny install.`);
  }
}

export async function detectCodexBinary(env: NodeJS.ProcessEnv = process.env): Promise<CodexDetection> {
  const binary = env.CODEX_BINARY?.trim()
    ? path.resolve(expandHomePath(env.CODEX_BINARY.trim()))
    : (await execa("which", ["codex"])).stdout.trim().split("\n")[0] ?? "";
  if (!binary) {
    throw new Error(`codex was not found in PATH. Install Codex ${minimumCodexVersion}+ or set CODEX_BINARY.`);
  }
  const result = await execa(binary, ["--version"], { reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`failed to run ${binary} --version: ${result.stderr || `exit ${result.exitCode}`}`);
  }
  const version = parseCodexVersion(result.stdout.trim());
  if (!version || compareSemver(version, minimumCodexVersion) < 0) {
    throw new Error(`Codex ${minimumCodexVersion}+ is required. Found: ${result.stdout.trim() || "unknown"}. Install a newer Codex or set CODEX_BINARY.`);
  }
  return { binary, version };
}

export function parseCodexVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?)/.exec(output)?.[1];
}

export function compareSemver(left: string, right: string): number {
  const leftParts = left.replace(/[-+].*$/, "").split(".").map((part) => Number(part));
  const rightParts = right.replace(/[-+].*$/, "").split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function buildEnvSelection(env: NodeJS.ProcessEnv): { options: { value: string; label: string; hint?: string }[]; initialValues: string[] } {
  const keys = Object.keys(env)
    .filter((key) => !key.startsWith("TWINNY_") && env[key] !== undefined)
    .sort((left, right) => left.localeCompare(right));
  return {
    options: keys.map((key) => ({
      value: key,
      label: key,
      hint: defaultIncludeEnvKey(key) ? undefined : "默认排除"
    })),
    initialValues: keys.filter(defaultIncludeEnvKey)
  };
}

export function defaultIncludeEnvKey(key: string): boolean {
  return !sensitiveEnvPattern.test(key) && !terminalEnvKeys.has(key);
}

export async function readCodexDefaults(homeDir = os.homedir()): Promise<CodexDefaults> {
  const fallback = { model: "gpt-5.5", effort: "medium" };
  const configPath = path.join(homeDir, ".codex", "config.toml");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return fallback;
    }
    throw error;
  }
  const parsed = parse(raw);
  return {
    model: stringField(parsed, "model") ?? fallback.model,
    effort: stringField(parsed, "model_reasoning_effort") ?? fallback.effort
  };
}

async function promptBotCredentials(): Promise<BotCredentials> {
  for (;;) {
    const choice = await cancelable(
      p.select<BotChoice>({
        message: "使用什么飞书机器人？",
        options: [
          { value: "auto", label: "一键创建/选择", hint: "推荐" },
          { value: "manual", label: "手动输入 AppID / AppSecret" }
        ],
        initialValue: "auto"
      })
    );
    try {
      const credentials = choice === "auto" ? await createBotWithBrowser() : await promptManualBotCredentials();
      await validateBotCredentials(credentials);
      return credentials;
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function createBotWithBrowser(): Promise<BotCredentials> {
  const begin = await requestLarkAppRegistration(installWizardLarkBrand);
  const verificationUrl = buildLarkVerificationUrl(begin.verificationUriComplete, TWINNY_VERSION);
  p.note(verificationUrl, "在浏览器中完成机器人创建/选择");
  await openBrowserBestEffort(verificationUrl);
  const result = await pollWithEscape("等待浏览器内操作完成，按 Esc 返回上一步", (signal) =>
    pollLarkAppRegistration(installWizardLarkBrand, begin.deviceCode, {
      interval: begin.interval,
      expiresIn: begin.expiresIn,
      signal
    })
  );
  if (!result) {
    throw new Error("已返回机器人选择");
  }
  if (result.brand !== installWizardLarkBrand) {
    throw new Error("Twinny install wizard currently only supports Feishu apps.");
  }
  return {
    appId: result.appId,
    appSecret: result.appSecret,
    brand: installWizardLarkBrand
  };
}

async function promptManualBotCredentials(): Promise<BotCredentials> {
  const appId = await cancelable(
    p.text({
      message: "App ID",
      validate: (value) => (value?.trim() ? undefined : "App ID is required")
    })
  );
  const appSecret = await cancelable(
    p.password({
      message: "App Secret",
      validate: (value) => (value?.trim() ? undefined : "App Secret is required")
    })
  );
  return {
    appId: appId.trim(),
    appSecret: appSecret.trim(),
    brand: installWizardLarkBrand
  };
}

async function validateBotCredentials(credentials: BotCredentials): Promise<void> {
  const s = p.spinner();
  s.start("校验机器人凭据");
  try {
    const tokenManager = createTenantAccessTokenManager(credentials);
    await tokenManager.getTenantAccessToken({ forceRefresh: true });
    s.stop("机器人凭据可用");
  } catch (error) {
    s.error("机器人凭据校验失败");
    throw error;
  }
}

async function promptOwnerIdentity(bot: BotCredentials): Promise<OwnerIdentity> {
  for (;;) {
    const choice = await cancelable(
      p.select<OwnerChoice>({
        message: "获取 owner 信息",
        options: [
          { value: "browser", label: "通过浏览器授权", hint: "推荐" },
          { value: "manual", label: "手动设置" }
        ],
        initialValue: "browser"
      })
    );
    try {
      return choice === "browser" ? await authorizeOwnerInBrowser(bot) : await promptManualOwner(bot);
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function authorizeOwnerInBrowser(bot: BotCredentials): Promise<OwnerIdentity> {
  const authorization = await requestLarkDeviceAuthorization({
    appId: bot.appId,
    appSecret: bot.appSecret,
    brand: bot.brand
  });
  p.note(authorization.verificationUriComplete, "在浏览器中完成 owner 授权");
  await openBrowserBestEffort(authorization.verificationUriComplete);
  const token = await pollWithEscape("等待 owner 授权完成，按 Esc 返回上一步", (signal) =>
    pollLarkDeviceToken(
      {
        appId: bot.appId,
        appSecret: bot.appSecret,
        brand: bot.brand,
        deviceCode: authorization.deviceCode,
        interval: authorization.interval,
        expiresIn: authorization.expiresIn
      },
      { signal }
    )
  );
  if (!token) {
    throw new Error("已返回 owner 选择");
  }
  const user = await getLarkBrowserUserInfo({ accessToken: token.accessToken, brand: bot.brand });
  return { openId: user.openId, displayName: user.name };
}

async function promptManualOwner(bot: BotCredentials): Promise<OwnerIdentity> {
  const openId = await cancelable(
    p.text({
      message: "Owner open_id",
      validate: (value) => (value?.trim() ? undefined : "open_id is required")
    })
  );
  const discoveredName = await lookupOwnerName(bot, openId.trim()).catch(() => undefined);
  if (discoveredName) {
    p.log.success(`Owner: ${discoveredName}`);
    return { openId: openId.trim(), displayName: discoveredName };
  }
  const displayName = await cancelable(
    p.text({
      message: "无法通过 bot 查询到 owner 名称，请手动输入 display name",
      validate: (value) => (value?.trim() ? undefined : "display name is required")
    })
  );
  return { openId: openId.trim(), displayName: displayName.trim() };
}

async function lookupOwnerName(bot: BotCredentials, openId: string): Promise<string | undefined> {
  const openApiClient = createOpenApiClient(bot);
  return new LarkUserDirectory({ openApiClient }).getUserNameByOpenId(openId);
}

async function promptLaunchEnvironment(home: string, env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("TWINNY_") && value !== undefined) {
      result[key] = value;
    }
  }
  result.TWINNY_HOME = home;

  const includeOther = await cancelable(
    p.confirm({
      message: "是否导入其它环境变量到 LaunchAgent？",
      initialValue: true
    })
  );
  if (!includeOther) {
    return result;
  }

  const selection = buildEnvSelection(env);
  if (selection.options.length === 0) {
    return result;
  }
  const selected = await cancelable(
    p.multiselect<string>({
      message: "选择要导入的环境变量",
      options: selection.options,
      initialValues: selection.initialValues,
      required: false,
      maxItems: 14
    })
  );
  for (const key of selected) {
    const value = env[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  result.TWINNY_HOME = home;
  return result;
}

async function finalizeInstall(input: {
  config: TwinnyConfig;
  appSecret: string;
  environment: Record<string, string | undefined>;
  secretStore?: SecretStore;
}): Promise<void> {
  const s = p.spinner();
  s.start("初始化 Twinny home");
  try {
    const entrypoint = await resolveLaunchAgentEntrypoint(input.config.home);
    await bootstrapTwinnyHome(input.config);
    await (input.secretStore ?? new SecurityCliSecretStore()).set(input.config.homeIdentity.keychainAccounts.larkAppSecret, input.appSecret);
    await installLaunchAgent({
      config: input.config,
      entrypoint,
      environment: input.environment
    });
    s.stop("Twinny home 和 LaunchAgent 已创建");
  } catch (error) {
    s.error("初始化失败");
    throw error;
  }

  const assetSpinner = p.spinner();
  assetSpinner.start("上传 Twinny 资源");
  await uploadBundledAssets(input.config, input.appSecret);
  assetSpinner.stop("资源上传步骤完成");
}

async function uploadBundledAssets(config: TwinnyConfig, appSecret: string): Promise<void> {
  const paths = createRuntimePaths(config.home);
  const larkFiles = new LarkFileDownloader({ openApiClient: createOpenApiClient({ appId: config.auth.larkAppId, appSecret, brand: config.auth.larkBrand }) });
  await provisionLarkAssetImageKeys({
    cacheFile: paths.larkAssetsFile,
    logoFilePath: resolveBundledLogoPath(),
    bannerFilePath: resolveBundledBannerPath(),
    uploader: larkFiles,
    logger: {
      warn: (_metadataOrMessage?: unknown, message?: string) =>
        p.log.warn(message ?? "failed to upload lark asset image; continuing without it")
    }
  });
}

function createTenantAccessTokenManager(credentials: BotCredentials): TenantAccessTokenManager {
  return new TenantAccessTokenManager({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    baseUrl: resolveLarkEndpoints(credentials.brand).openApi
  });
}

function createOpenApiClient(credentials: BotCredentials): LarkOpenApiClient {
  const tokenManager = createTenantAccessTokenManager(credentials);
  return new LarkOpenApiClient({
    tokenManager,
    baseUrl: resolveLarkEndpoints(credentials.brand).openApi
  });
}

async function resolveLaunchAgentEntrypoint(home: string): Promise<string> {
  const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : process.execPath;
  if (!isNpxEntrypoint(entrypoint)) {
    return entrypoint;
  }
  const identity = await readPackageIdentity();
  const runnerDir = path.join(home, "runner");
  await execa("npm", ["install", "--prefix", runnerDir, "--omit=dev", "--no-audit", "--no-fund", `${identity.name}@${identity.version}`], {
    stdio: "inherit"
  });
  return path.join(runnerDir, "node_modules", ".bin", "twinny");
}

export function isNpxEntrypoint(entrypoint: string): boolean {
  return entrypoint.split(path.sep).includes("_npx");
}

async function readPackageIdentity(): Promise<{ name: string; version: string }> {
  const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const raw = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
  if (typeof raw.name !== "string" || typeof raw.version !== "string") {
    throw new Error("package.json is missing name or version");
  }
  return { name: raw.name, version: raw.version };
}

async function pollWithEscape<T>(message: string, run: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const controller = new AbortController();
  const cleanup = installEscapeAbort(controller);
  const s = p.spinner();
  s.start(message);
  try {
    const result = await run(controller.signal);
    s.stop("完成");
    return result;
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      s.cancel("已取消");
      return undefined;
    }
    s.error("失败");
    throw error;
  } finally {
    cleanup();
  }
}

function installEscapeAbort(controller: AbortController): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return () => undefined;
  }
  const wasRaw = stdin.isRaw;
  const onData = (chunk: Buffer) => {
    if (chunk.includes(0x1b)) {
      controller.abort();
    }
  };
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  return () => {
    stdin.off("data", onData);
    stdin.setRawMode(wasRaw);
  };
}

async function openBrowserBestEffort(url: string): Promise<void> {
  if (process.platform === "darwin") {
    await execa("open", [url], { reject: false });
    return;
  }
  if (process.platform === "win32") {
    await execa("cmd", ["/c", "start", "", url], { reject: false });
    return;
  }
  await execa("xdg-open", [url], { reject: false });
}

async function cancelable<T>(value: Promise<T | symbol>): Promise<T> {
  const result = await value;
  if (p.isCancel(result)) {
    p.cancel("安装已取消");
    process.exit(0);
  }
  return result;
}

function stringField(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
