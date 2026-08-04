import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { TwinnyError } from "../errors.js";
import { ensureGuestWorkspaceTrust, ensureProjectTrust } from "../profiles/index.js";
import { commandForPlatform } from "../platform/commands.js";
import { GUEST_PROFILE_NAME, HOST_PROFILE_NAME, type CodexThreadNameUpdate, type ProfileName } from "../types.js";
import {
  CodexProtocolClient,
  createInitializeParams,
  type CodexNotificationMessage,
  type InitializeParams,
  type InitializeResponse
} from "./protocol.js";
import { parseCodexThreadNameUpdatedNotification } from "./thread-name.js";
import {
  clearCodexThreadGoal,
  getCodexThreadGoal,
  resumeCodexThreadGoal,
  runCodexThreadGoal,
  setCodexThreadGoal,
  type GoalResumeOptions,
  type GoalRunOptions,
  type ThreadGoal
} from "./goal.js";
import {
  forkCodexThread,
  injectCodexThreadItems,
  listCodexThreads,
  readCodexThread,
  resumeCodexThread,
  rollbackCodexThread,
  searchCodexThreads,
  setCodexThreadName,
  startCodexThread,
  unsubscribeCodexThread,
  type ThreadForkResponse,
  type ThreadListParams,
  type ThreadListResponse,
  type ThreadReadResponse,
  type ThreadResumeResponse,
  type ThreadRollbackResponse,
  type ThreadSearchParams,
  type ThreadSearchResponse,
  type ThreadStartResponse
} from "./thread.js";
import {
  compactCodexThread,
  DANGER_FULL_ACCESS_SANDBOX_POLICY,
  interruptCodexTurn,
  startCodexTurn,
  steerCodexTurn,
  type CodexTurnInput,
  type ThreadCompactStartOptions,
  type TurnStartOptions
} from "./turn.js";

export interface CodexAppServerOptions {
  profile: ProfileName;
  binary: string;
  codexHome: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  clientVersion?: string;
  masqueradeAsCodexCli?: boolean;
  stopTimeoutMs?: number;
}

export interface CodexAppServerProcessTreeTarget {
  pid: number;
  platform: NodeJS.Platform;
  isolatedProcessGroup: boolean;
  killChild(signal: NodeJS.Signals): boolean;
  signalAttempts: Map<NodeJS.Signals, Promise<boolean>>;
}

export interface CodexAppServerProcessTreeDependencies {
  killProcess?: typeof process.kill;
  killWindowsTree?: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  currentTarget?: CodexAppServerProcessTreeTarget;
}

export interface ProfileCodexAppServerConfig {
  profile: ProfileName;
  codexHome: string;
}

export interface ProfileCodexAppServerPoolOptions {
  binary: string;
  profiles: Record<ProfileName, { codexHome: string }>;
  requestTimeoutMs?: number;
  clientVersion?: string;
  masqueradeAsCodexCli?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface CodexAppServerEvents {
  stderr: [chunk: string];
  versionProbeFailed: [failure: CodexVersionProbeFailure];
  notification: [message: CodexNotificationMessage];
  threadNameUpdated: [update: CodexThreadNameUpdate];
  unhealthy: [error: Error];
  exit: [code: number | null, signal: NodeJS.Signals | null];
}

export interface CodexVersionProbeFailure {
  binary: string;
  reason: string;
  exitCode?: number;
  stderr?: string;
}

export declare interface CodexAppServer {
  on<K extends keyof CodexAppServerEvents>(
    event: K,
    listener: (...args: CodexAppServerEvents[K]) => void
  ): this;
  once<K extends keyof CodexAppServerEvents>(
    event: K,
    listener: (...args: CodexAppServerEvents[K]) => void
  ): this;
  off<K extends keyof CodexAppServerEvents>(
    event: K,
    listener: (...args: CodexAppServerEvents[K]) => void
  ): this;
  emit<K extends keyof CodexAppServerEvents>(event: K, ...args: CodexAppServerEvents[K]): boolean;
}

export class CodexAppServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private processTree: CodexAppServerProcessTreeTarget | undefined;
  private protocolClient: CodexProtocolClient | undefined;
  private initializeResponse: InitializeResponse | undefined;
  private startPromise: Promise<InitializeResponse> | undefined;
  private codexVersion: string | undefined;

  constructor(private readonly options: CodexAppServerOptions) {
    super();
  }

  get protocol(): CodexProtocolClient {
    if (!this.protocolClient) {
      throw new Error("Codex app-server is not started");
    }
    return this.protocolClient;
  }

  get initialized(): InitializeResponse | undefined {
    return this.initializeResponse;
  }

  readCodexVersion(): string {
    return this.codexVersion ?? "不可用";
  }

  async start(): Promise<InitializeResponse> {
    if (this.protocolClient && this.initializeResponse) {
      return this.initializeResponse;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startFresh();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startFresh(): Promise<InitializeResponse> {
    const codexVersion = await this.readCodexBinaryVersionBestEffort();

    if (this.protocolClient) {
      this.initializeResponse = await this.protocolClient.initialize(this.createInitializeParams(codexVersion));
      this.codexVersion = codexVersion;
      return this.initializeResponse;
    }

    const invocation = commandForPlatform(this.options.binary, ["app-server", "--listen", "stdio://"]);
    const spawnOptions = buildCodexAppServerSpawnOptions({
      cwd: this.options.cwd ?? process.cwd(),
      env: buildCodexAppServerEnv(this.options.codexHome, this.options.env ?? process.env)
    }, process.platform);
    const child = spawn(invocation.command, invocation.args, spawnOptions);
    const processTree = createCodexAppServerProcessTreeTarget(child, process.platform, spawnOptions.detached === true);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));

    const protocol = new CodexProtocolClient(child.stdout, child.stdin, {
      requestTimeoutMs: this.options.requestTimeoutMs,
      requestIdPrefix: `twinny-${this.profileName()}`
    });
    this.attachProtocolNotifications(protocol);
    this.child = child;
    this.processTree = processTree;
    this.protocolClient = protocol;
    this.initializeResponse = undefined;
    this.attachProtocolHealth(protocol, child, processTree);
    child.on("exit", (code, signal) => {
      const isCurrent = this.child === child && this.processTree === processTree;
      const cleanup = this.terminateProcessTreeBestEffort(processTree, "SIGKILL", "exit");
      if (!isCurrent) {
        void cleanup;
        return;
      }
      this.child = undefined;
      this.protocolClient = undefined;
      this.initializeResponse = undefined;
      void cleanup.then(() => {
        if (this.processTree === processTree) {
          this.processTree = undefined;
        }
        this.emit("exit", code, signal);
      });
    });
    protocol.start();

    try {
      this.initializeResponse = await protocol.initialize(this.createInitializeParams(codexVersion));
      this.codexVersion = codexVersion;
      return this.initializeResponse;
    } catch (error) {
      protocol.close();
      await this.terminateProcessTreeBestEffort(processTree, "SIGTERM", "start failure");
      await this.terminateProcessTreeBestEffort(processTree, "SIGKILL", "start failure");
      if (this.child === child) {
        this.child = undefined;
      }
      if (this.processTree === processTree) {
        this.processTree = undefined;
      }
      if (this.protocolClient === protocol) {
        this.protocolClient = undefined;
        this.initializeResponse = undefined;
      }
      throw error;
    }
  }

  private createInitializeParams(codexVersionOutput: string): InitializeParams {
    if (!this.options.masqueradeAsCodexCli) {
      return createInitializeParams(this.options.clientVersion);
    }
    return createInitializeParams({
      name: "codex-tui",
      title: null,
      version: resolveCodexTuiClientInfoVersion(codexVersionOutput)
    });
  }

  private attachProtocolNotifications(protocol: CodexProtocolClient): void {
    protocol.on("notification", (message) => {
      this.emit("notification", message);
      const update = parseCodexThreadNameUpdatedNotification(message);
      if (update) {
        this.emit("threadNameUpdated", update);
      }
    });
  }

  private attachProtocolHealth(
    protocol: CodexProtocolClient,
    child: ChildProcessWithoutNullStreams,
    processTree: CodexAppServerProcessTreeTarget
  ): void {
    let unhealthy = false;
    const markUnhealthy = (error: Error): void => {
      if (
        unhealthy ||
        this.child !== child ||
        this.protocolClient !== protocol ||
        hasExited(child)
      ) {
        return;
      }
      unhealthy = true;
      this.initializeResponse = undefined;
      protocol.close();
      void this.terminateProcessTreeBestEffort(processTree, "SIGKILL", "unhealthy");
      this.emit("unhealthy", error);
    };
    const closedError = (stream: "protocol" | "stdin"): TwinnyError =>
      new TwinnyError(`Codex app-server ${stream} stream closed unexpectedly`, "CODEX_APP_SERVER_UNHEALTHY");

    protocol.on("error", markUnhealthy);
    protocol.once("close", () => markUnhealthy(closedError("protocol")));
    child.once("error", markUnhealthy);
    child.stdin.once("error", markUnhealthy);
    child.stdin.once("close", () => markUnhealthy(closedError("stdin")));
    child.stdout.once("error", markUnhealthy);
  }

  async startThread(
    cwd: string,
    options: { developerInstructions?: string; model?: string; effort?: string } = {}
  ): Promise<ThreadStartResponse> {
    await this.prepareThreadWorkspace(cwd);
    return startCodexThread(this.protocol, {
      cwd,
      developerInstructions: options.developerInstructions,
      model: options.model,
      effort: options.effort
    });
  }

  async resumeThread(threadId: string, cwd: string): Promise<ThreadResumeResponse> {
    await this.prepareThreadWorkspace(cwd);
    return resumeCodexThread(this.protocol, threadId, { cwd });
  }

  async forkThread(
    threadId: string,
    cwd: string,
    options: { ephemeral?: boolean; developerInstructions?: string; model?: string; effort?: string } = {}
  ): Promise<ThreadForkResponse> {
    await this.prepareThreadWorkspace(cwd);
    return forkCodexThread(this.protocol, threadId, { cwd, ...options });
  }

  async injectThreadItems(threadId: string, items: unknown[]): Promise<void> {
    await injectCodexThreadItems(this.protocol, { threadId, items });
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    await unsubscribeCodexThread(this.protocol, threadId);
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await setCodexThreadName(this.protocol, { threadId, name });
  }

  async readThreadMetadata(threadId: string): Promise<{ path?: string | null }> {
    const response = await readCodexThread(this.protocol, threadId, { includeTurns: false });
    return { path: typeof response.thread.path === "string" ? response.thread.path : response.thread.path ?? null };
  }

  async readThread(threadId: string, options: { includeTurns?: boolean } = {}): Promise<ThreadReadResponse> {
    return readCodexThread(this.protocol, threadId, { includeTurns: options.includeTurns === true });
  }

  async listThreads(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    return listCodexThreads(this.protocol, params);
  }

  async searchThreads(params: ThreadSearchParams): Promise<ThreadSearchResponse> {
    return searchCodexThreads(this.protocol, params);
  }

  async rollbackThread(threadId: string, numTurns: number): Promise<ThreadRollbackResponse> {
    return rollbackCodexThread(this.protocol, { threadId, numTurns });
  }

  async startTurn(options: TurnStartOptions): Promise<import("../types.js").CodexTurnResult> {
    if (options.cwd) {
      await this.prepareThreadWorkspace(options.cwd);
    }
    return startCodexTurn(this.protocol, this.buildTurnStartOptions(options), {
      requestTimeoutMs: this.options.requestTimeoutMs
    });
  }

  async compactThread(options: ThreadCompactStartOptions & { cwd?: string }): Promise<import("../types.js").CodexTurnResult> {
    if (options.cwd) {
      await this.prepareThreadWorkspace(options.cwd);
    }
    return compactCodexThread(this.protocol, options, { requestTimeoutMs: this.options.requestTimeoutMs });
  }

  async steerTurn(options: { threadId: string; turnId: string; text?: string; input?: CodexTurnInput; cwd?: string }): Promise<void> {
    if (options.cwd) {
      await this.prepareThreadWorkspace(options.cwd);
    }
    await steerCodexTurn(this.protocol, options);
  }

  async interruptTurn(options: { threadId: string; turnId: string }): Promise<void> {
    await interruptCodexTurn(this.protocol, options);
  }

  async readAccountRateLimits(): Promise<unknown> {
    return this.protocol.request("account/rateLimits/read");
  }

  async setThreadGoal(threadId: string, objective: string): Promise<ThreadGoal> {
    return setCodexThreadGoal(this.protocol, { threadId, objective }, { requestTimeoutMs: this.options.requestTimeoutMs });
  }

  async getThreadGoal(threadId: string): Promise<ThreadGoal | null> {
    return getCodexThreadGoal(this.protocol, threadId, { requestTimeoutMs: this.options.requestTimeoutMs });
  }

  async clearThreadGoal(threadId: string): Promise<void> {
    await clearCodexThreadGoal(this.protocol, threadId, { requestTimeoutMs: this.options.requestTimeoutMs });
  }

  async runGoal(options: GoalRunOptions): Promise<import("../types.js").CodexTurnResult> {
    if (options.cwd) {
      await this.prepareThreadWorkspace(options.cwd);
    }
    return runCodexThreadGoal(this.protocol, options, { requestTimeoutMs: this.options.requestTimeoutMs });
  }

  async resumeGoal(options: GoalResumeOptions): Promise<import("../types.js").CodexTurnResult> {
    if (options.cwd) {
      await this.prepareThreadWorkspace(options.cwd);
    }
    return resumeCodexThreadGoal(this.protocol, options, { requestTimeoutMs: this.options.requestTimeoutMs });
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const child = this.child;
    const processTree = this.processTree;
    this.protocolClient?.close();
    this.protocolClient = undefined;
    this.initializeResponse = undefined;

    if (!child || !processTree) {
      return;
    }

    const gracefulExit = waitForChildExit(child, this.options.stopTimeoutMs ?? 3_000);
    if (!hasExited(child) && !processTree.signalAttempts.has("SIGKILL")) {
      await this.terminateProcessTree(processTree, signal);
    }

    await gracefulExit;
    await this.terminateProcessTree(processTree, "SIGKILL");
    await waitForChildExit(child, 2_000);
    if (this.child === child) {
      this.child = undefined;
    }
    if (this.processTree === processTree) {
      this.processTree = undefined;
    }
  }

  private terminateProcessTree(
    target: CodexAppServerProcessTreeTarget,
    signal: NodeJS.Signals
  ): Promise<boolean> {
    return terminateCodexAppServerProcessTree(target, signal, { currentTarget: this.processTree });
  }

  private async terminateProcessTreeBestEffort(
    target: CodexAppServerProcessTreeTarget,
    signal: NodeJS.Signals,
    reason: string
  ): Promise<void> {
    try {
      await this.terminateProcessTree(target, signal);
    } catch (error) {
      this.emit("stderr", `failed to terminate Codex app-server process tree after ${reason}: ${errorMessage(error)}`);
    }
  }

  private async prepareThreadWorkspace(cwd: string): Promise<void> {
    if (this.options.profile === GUEST_PROFILE_NAME) {
      await ensureGuestWorkspaceTrust(this.options.codexHome, cwd);
      return;
    }
    await ensureProjectTrust(this.options.codexHome, cwd);
  }

  private buildTurnStartOptions(options: TurnStartOptions): TurnStartOptions {
    if (this.options.profile !== HOST_PROFILE_NAME) {
      return options;
    }
    return {
      ...options,
      sandboxPolicy: DANGER_FULL_ACCESS_SANDBOX_POLICY
    };
  }

  private profileName(): ProfileName {
    return this.options.profile;
  }

  private async readCodexBinaryVersionBestEffort(): Promise<string> {
    const invocation = commandForPlatform(this.options.binary, ["--version"]);
    try {
      const result = await execa(invocation.command, invocation.args, {
        env: buildCodexAppServerEnv(this.options.codexHome, this.options.env ?? process.env),
        reject: false,
        timeout: 5_000
      });
      const version = result.stdout.trim() || result.stderr.trim();
      if (result.exitCode === 0 && parseCodexCliVersionOutput(version)) {
        return version;
      }
      this.emit("versionProbeFailed", {
        binary: invocation.command,
        reason: version ? "unparseable output" : "empty output",
        exitCode: result.exitCode ?? undefined,
        stderr: result.stderr.trim() || undefined
      });
    } catch (error) {
      this.emit("versionProbeFailed", {
        binary: invocation.command,
        reason: error instanceof Error ? error.message : "failed to run codex --version"
      });
    }
    return this.readCodexBinaryVersionFromPathBestEffort();
  }

  private async readCodexBinaryVersionFromPathBestEffort(): Promise<string> {
    const candidates = [this.options.binary];
    try {
      candidates.push(await fs.realpath(this.options.binary));
    } catch {
      // Path probing is best effort only; the command failure above is the useful diagnostic.
    }
    for (const candidate of candidates) {
      const version = parseCodexCliVersionOutput(candidate);
      if (version) {
        return version;
      }
    }
    return "";
  }
}

export class ProfileCodexAppServerPool {
  private readonly servers = new Map<ProfileName, CodexAppServer>();

  constructor(private readonly options: ProfileCodexAppServerPoolOptions) {
    const profiles = options.profiles;
    for (const profile of Object.keys(profiles)) {
      this.servers.set(
        profile,
        new CodexAppServer({
          profile,
          binary: options.binary,
          codexHome: profiles[profile].codexHome,
          env: options.env,
          requestTimeoutMs: options.requestTimeoutMs,
          clientVersion: options.clientVersion,
          masqueradeAsCodexCli: options.masqueradeAsCodexCli
        })
      );
    }
  }

  async startAll(): Promise<Record<ProfileName, InitializeResponse>> {
    const entries = await Promise.all(
      Array.from(this.servers.entries(), async ([profile, server]) => [profile, await server.start()] as const)
    );
    return Object.fromEntries(entries);
  }

  get(profile: ProfileName): CodexAppServer {
    const server = this.servers.get(profile);
    if (!server) {
      throw new Error(`No Codex app-server configured for profile ${profile}`);
    }
    return server;
  }

  listProfiles(): ProfileName[] {
    return [...this.servers.keys()];
  }

  replace(profile: ProfileName, config: { binary?: string; codexHome: string }): CodexAppServer {
    const server = new CodexAppServer({
      profile,
      binary: config.binary ?? this.options.binary,
      codexHome: config.codexHome,
      env: this.options.env,
      requestTimeoutMs: this.options.requestTimeoutMs,
      clientVersion: this.options.clientVersion,
      masqueradeAsCodexCli: this.options.masqueradeAsCodexCli
    });
    this.servers.set(profile, server);
    return server;
  }

  async remove(profile: ProfileName, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const server = this.servers.get(profile);
    if (!server) {
      return;
    }
    this.servers.delete(profile);
    await server.stop(signal);
  }

  async restart(profile: ProfileName): Promise<InitializeResponse> {
    const server = this.get(profile);
    await server.stop();
    return server.start();
  }

  async stopAll(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    await Promise.all(Array.from(this.servers.values(), (server) => server.stop(signal)));
  }
}

export function parseCodexCliVersionOutput(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?)/.exec(output)?.[1];
}

export function resolveCodexTuiClientInfoVersion(codexVersionOutput: string): string {
  return sanitizeUserAgentVersionToken(parseCodexCliVersionOutput(codexVersionOutput)) ?? "";
}

function sanitizeUserAgentVersionToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/.test(trimmed) ? trimmed : undefined;
}

export function buildCodexAppServerSpawnOptions(
  options: Pick<SpawnOptionsWithoutStdio, "cwd" | "env">,
  platform: NodeJS.Platform = process.platform
): SpawnOptionsWithoutStdio {
  return {
    ...options,
    detached: platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  };
}

export function createCodexAppServerProcessTreeTarget(
  child: Pick<ChildProcessWithoutNullStreams, "pid" | "kill">,
  platform: NodeJS.Platform = process.platform,
  isolatedProcessGroup = platform !== "win32"
): CodexAppServerProcessTreeTarget {
  return {
    pid: child.pid ?? 0,
    platform,
    isolatedProcessGroup,
    killChild: (signal) => child.kill(signal),
    signalAttempts: new Map()
  };
}

export function terminateCodexAppServerProcessTree(
  target: CodexAppServerProcessTreeTarget,
  signal: NodeJS.Signals,
  dependencies: CodexAppServerProcessTreeDependencies = {}
): Promise<boolean> {
  const existing = target.signalAttempts.get(signal);
  if (existing) {
    return existing;
  }
  const attempt = terminateCodexAppServerProcessTreeOnce(target, signal, dependencies).catch((error) => {
    target.signalAttempts.delete(signal);
    throw error;
  });
  target.signalAttempts.set(signal, attempt);
  return attempt;
}

async function terminateCodexAppServerProcessTreeOnce(
  target: CodexAppServerProcessTreeTarget,
  signal: NodeJS.Signals,
  dependencies: CodexAppServerProcessTreeDependencies
): Promise<boolean> {
  const current = dependencies.currentTarget;
  if (current && current !== target && current.pid === target.pid) {
    return false;
  }
  if (!Number.isSafeInteger(target.pid) || target.pid <= 1 || target.pid === process.pid) {
    return false;
  }

  if (target.platform === "win32") {
    try {
      await (dependencies.killWindowsTree ?? killWindowsProcessTree)(target.pid, signal);
      return true;
    } catch (error) {
      if (isMissingProcessError(error)) {
        return true;
      }
      try {
        return target.killChild(signal);
      } catch (childError) {
        if (isMissingProcessError(childError)) {
          return true;
        }
        throw error;
      }
    }
  }

  if (!target.isolatedProcessGroup) {
    try {
      return target.killChild(signal);
    } catch (error) {
      if (isMissingProcessError(error)) {
        return true;
      }
      throw error;
    }
  }

  try {
    (dependencies.killProcess ?? process.kill)(-target.pid, signal);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return true;
    }
    throw error;
  }
}

async function killWindowsProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") {
    args.push("/F");
  }
  const result = await execa("taskkill", args, {
    reject: false,
    timeout: 5_000,
    windowsHide: true
  });
  if (result.exitCode === 0 || result.exitCode === 128) {
    return;
  }
  throw new Error(result.stderr.trim() || `taskkill exited with code ${result.exitCode ?? "unknown"}`);
}

function isMissingProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    timeout.unref?.();

    const onExit = (): void => {
      cleanup();
      resolve(true);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };

    child.once("exit", onExit);
  });
}

export function buildCodexAppServerEnv(codexHome: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.PATH = codexChildPath(env.PATH ?? env.Path);
  env.CODEX_HOME = path.resolve(codexHome);
  env.NO_COLOR = source.NO_COLOR ?? "1";
  return env;
}

function defaultPath(): string {
  if (process.platform === "win32") {
    return process.env.PATH ?? process.env.Path ?? "";
  }
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

function codexChildPath(sourcePath: string | undefined): string {
  const nodeBinDir = path.dirname(process.execPath);
  const entries = [nodeBinDir, ...(sourcePath ?? defaultPath()).split(path.delimiter)].filter(Boolean);
  return [...new Set(entries)].join(path.delimiter);
}
