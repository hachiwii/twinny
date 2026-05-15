import prompts, { type PromptObject } from "prompts";
import {
  bootstrapTwinnyHome,
  createTwinnyConfig,
  readConfigStatus,
  SECRET_ACCOUNTS,
  SECRET_REFS,
  SecurityCliSecretStore,
  secretAccountFromRef,
  type SecretStore
} from "../config/index.js";
import {
  LarkUserOAuthDeviceFlow,
  type DeviceAuthorizationResponse,
  type LarkAuthenticatedUser,
  type UserAccessTokenResult
} from "../lark/index.js";
import type { TwinnyConfig } from "../types.js";

export async function runWizardCommand(): Promise<void> {
  const { runDoctorCommand } = await import("../observability/health.js");
  await runFirstRunWizard({ doctorHook: runDoctorCommand });
}

export interface WizardPrompt {
  <T extends string = string>(questions: PromptObject<T> | Array<PromptObject<T>>): Promise<prompts.Answers<T>>;
}

export interface WizardOutput {
  writeLine(message: string): void;
}

export interface WizardOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  secretStore?: SecretStore;
  prompt?: WizardPrompt;
  authClientFactory?: (credentials: LarkOwnerAuthCredentials) => LarkOwnerAuthClient;
  doctorHook?: () => Promise<void>;
  output?: WizardOutput;
}

export type WizardMode = "status" | "authorized";

export const wizardProjectName = "🐰 Twinny";
export const wizardProjectDescription = "Connect Feishu/Lark p2p messages to local Codex app-server threads.";
export const wizardDivider = "────────────────────────────────────────";
export const wizardOwnerAuthScope = "approval:task:read approval:instance:read approval:task:write offline_access";

export interface WizardResult {
  mode: WizardMode;
  config: TwinnyConfig;
}

export interface LarkOwnerAuthCredentials {
  appId: string;
  appSecret: string;
}

export interface LarkOwnerAuthClient {
  requestDeviceAuthorization(scope?: string): Promise<DeviceAuthorizationResponse>;
  pollDeviceToken(options: {
    deviceCode: string;
    expiresIn?: number;
    interval?: number;
  }): Promise<UserAccessTokenResult>;
  getUserInfo(accessToken: string): Promise<LarkAuthenticatedUser>;
}

export async function runFirstRunWizard(options: WizardOptions = {}): Promise<WizardResult> {
  const output = options.output ?? consoleOutput;
  const secretStore = options.secretStore ?? new SecurityCliSecretStore();
  const status = await readConfigStatus({ home: options.home, env: options.env });

  if (status.complete && status.config) {
    showWizardIntro(output);
    await showExistingConfigStatus(status.config, secretStore, output, options.env);
    await options.doctorHook?.();
    return { mode: "status", config: status.config };
  }

  const interactive = options.interactive ?? process.stdin.isTTY;
  if (!interactive) {
    throw new Error(`Twinny is not configured and no TTY is available. Run "twinny wizard" first.`);
  }

  showWizardIntro(output);
  const prompt = options.prompt ?? prompts;
  const config = await configureWithAuthorization(
    prompt,
    secretStore,
    status.paths.home,
    output,
    options.authClientFactory ?? createDefaultOwnerAuthClient
  );

  await bootstrapTwinnyHome(config, { overwriteConfig: true });
  output.writeLine(`Wrote Twinny config: ${status.paths.configFile}`);
  output.writeLine(`Prepared owner CODEX_HOME: ${config.roles.owner.codexHome}`);
  output.writeLine(`Prepared guest CODEX_HOME: ${config.roles.guest.codexHome}`);

  await options.doctorHook?.();
  return { mode: "authorized", config };
}

export async function showExistingConfigStatus(
  config: TwinnyConfig,
  secretStore: SecretStore,
  output: WizardOutput = consoleOutput,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const appSecretExists =
    Boolean(env.TWINNY_LARK_APP_SECRET) || (await secretStore.has(secretAccountFromRef(config.lark.appSecretRef)));
  const ownerTokenExists = config.owner.tokenRef
    ? await secretStore.has(secretAccountFromRef(config.owner.tokenRef))
    : false;

  output.writeLine("Twinny is already configured.");
  output.writeLine(`TWINNY_HOME: ${config.home}`);
  output.writeLine(`Lark app_id: ${config.lark.appId}`);
  output.writeLine(`Lark app_secret present: ${formatBoolean(appSecretExists)}`);
  output.writeLine(`Owner: ${config.owner.displayName} (${config.owner.openId})`);
  output.writeLine(`Owner user token present: ${formatBoolean(ownerTokenExists)}`);
}

async function configureWithAuthorization(
  prompt: WizardPrompt,
  secretStore: SecretStore,
  home: string,
  output: WizardOutput,
  authClientFactory: (credentials: LarkOwnerAuthCredentials) => LarkOwnerAuthClient
): Promise<TwinnyConfig> {
  const answers = await prompt<keyof LarkOwnerAuthCredentials>([
    {
      type: "text",
      name: "appId",
      message: "Feishu/Lark app_id",
      validate: required
    },
    {
      type: "password",
      name: "appSecret",
      message: "Feishu/Lark app_secret",
      validate: required
    }
  ]);

  assertAuthAnswers(answers);

  const authClient = authClientFactory(answers);
  const authorization = await authClient.requestDeviceAuthorization(wizardOwnerAuthScope);
  output.writeLine("Open this Feishu/Lark authorization URL as the owner:");
  output.writeLine(authorization.verificationUriComplete);
  if (authorization.userCode) {
    output.writeLine(`User code: ${authorization.userCode}`);
  }
  output.writeLine("Waiting for owner authorization...");

  const token = await authClient.pollDeviceToken({
    deviceCode: authorization.deviceCode,
    expiresIn: authorization.expiresIn,
    interval: authorization.interval
  });
  const owner = await authClient.getUserInfo(token.accessToken);
  output.writeLine(`Authorized owner: ${owner.displayName} (${owner.openId})`);

  await secretStore.set(SECRET_ACCOUNTS.larkAppSecret, answers.appSecret);
  await secretStore.set(SECRET_ACCOUNTS.ownerUserToken, token.accessToken);
  if (token.refreshToken) {
    await secretStore.set(SECRET_ACCOUNTS.ownerRefreshToken, token.refreshToken);
  }

  return createTwinnyConfig({
    home,
    lark: {
      appId: answers.appId,
      appSecretRef: SECRET_REFS.larkAppSecret
    },
    owner: {
      openId: owner.openId,
      userId: owner.userId,
      displayName: owner.displayName,
      tokenRef: SECRET_REFS.ownerUserToken,
      refreshTokenRef: token.refreshToken ? SECRET_REFS.ownerRefreshToken : undefined
    }
  });
}

function assertAuthAnswers(
  answers: prompts.Answers<keyof LarkOwnerAuthCredentials>
): asserts answers is LarkOwnerAuthCredentials {
  for (const key of ["appId", "appSecret"] as const) {
    if (typeof answers[key] !== "string" || !answers[key].trim()) {
      throw new Error(`configuration was cancelled or missing ${key}`);
    }
    answers[key] = answers[key].trim();
  }
}

function required(value: string): true | string {
  return value.trim() ? true : "Required";
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

const consoleOutput: WizardOutput = {
  writeLine(message: string): void {
    console.log(message);
  }
};

function createDefaultOwnerAuthClient(credentials: LarkOwnerAuthCredentials): LarkOwnerAuthClient {
  return new LarkUserOAuthDeviceFlow({
    appId: credentials.appId,
    appSecret: credentials.appSecret
  });
}

export function showWizardIntro(output: WizardOutput = consoleOutput): void {
  output.writeLine(wizardDivider);
  output.writeLine(wizardProjectName);
  output.writeLine("");
  output.writeLine(wizardProjectDescription);
  output.writeLine(wizardDivider);
  output.writeLine("");
}
