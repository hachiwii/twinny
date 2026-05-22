import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { execa } from "execa";
import { ensureWorkspaceTrust } from "../roles/index.js";
import type { CodexThreadNameUpdate, ProfileName } from "../types.js";
import { CodexProtocolClient, createInitializeParams, type CodexNotificationMessage, type InitializeResponse } from "./protocol.js";
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
  resumeCodexThread,
  setCodexThreadName,
  startCodexThread,
  unsubscribeCodexThread,
  type ThreadForkResponse,
  type ThreadResumeResponse,
  type ThreadStartResponse
} from "./thread.js";
import {
  compactCodexThread,
  interruptCodexTurn,
  startCodexTurn,
  steerCodexTurn,
  type CodexTurnInput,
  type ThreadCompactStartOptions,
  type TurnStartOptions
} from "./turn.js";

export interface CodexAppServerOptions {
  profile?: ProfileName;
  role?: ProfileName;
  binary: string;
  codexHome: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  clientVersion?: string;
  stopTimeoutMs?: number;
}

export interface ProfileCodexAppServerConfig {
  profile: ProfileName;
  codexHome: string;
}

export interface ProfileCodexAppServerPoolOptions {
  binary: string;
  profiles?: Record<ProfileName, { codexHome: string }>;
  roles?: Record<ProfileName, { codexHome: string }>;
  requestTimeoutMs?: number;
  clientVersion?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CodexAppServerEvents {
  stderr: [chunk: string];
  notification: [message: CodexNotificationMessage];
  threadNameUpdated: [update: CodexThreadNameUpdate];
  exit: [code: number | null, signal: NodeJS.Signals | null];
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
      this.initializeResponse = await this.protocolClient.initialize(createInitializeParams(this.options.clientVersion));
      this.codexVersion = codexVersion;
      return this.initializeResponse;
    }

    const child = spawn(this.options.binary, ["app-server", "--listen", "stdio://"], {
      cwd: this.options.cwd ?? process.cwd(),
      env: buildCodexAppServerEnv(this.options.codexHome, this.options.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));

    const protocol = new CodexProtocolClient(child.stdout, child.stdin, {
      requestTimeoutMs: this.options.requestTimeoutMs,
      requestIdPrefix: `twinny-${this.profileName()}`
    });
    this.attachProtocolNotifications(protocol);
    this.child = child;
    this.protocolClient = protocol;
    this.initializeResponse = undefined;
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = undefined;
      }
      if (this.protocolClient === protocol) {
        this.protocolClient = undefined;
        this.initializeResponse = undefined;
      }
      this.emit("exit", code, signal);
    });
    protocol.start();

    this.initializeResponse = await protocol.initialize(createInitializeParams(this.options.clientVersion));
    this.codexVersion = codexVersion;
    return this.initializeResponse;
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

  async startThread(cwd: string, options: { developerInstructions?: string } = {}): Promise<ThreadStartResponse> {
    await this.prepareThreadWorkspace(cwd);
    return startCodexThread(this.protocol, { cwd, developerInstructions: options.developerInstructions });
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

  async startTurn(options: TurnStartOptions): Promise<import("../types.js").CodexTurnResult> {
    return startCodexTurn(this.protocol, options, { requestTimeoutMs: this.options.requestTimeoutMs });
  }

  async compactThread(options: ThreadCompactStartOptions & { cwd?: string }): Promise<import("../types.js").CodexTurnResult> {
    if (options.cwd) {
      await this.prepareThreadWorkspace(options.cwd);
    }
    return compactCodexThread(this.protocol, options, { requestTimeoutMs: this.options.requestTimeoutMs });
  }

  async steerTurn(options: { threadId: string; turnId: string; text?: string; input?: CodexTurnInput }): Promise<void> {
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
    this.protocolClient?.close();
    this.protocolClient = undefined;
    this.initializeResponse = undefined;

    if (!child) {
      return;
    }

    const gracefulExit = waitForChildExit(child, this.options.stopTimeoutMs ?? 3_000);
    if (!hasExited(child) && !child.killed) {
      child.kill(signal);
    }

    const stopped = await gracefulExit;
    if (!stopped && !hasExited(child)) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 2_000);
    }
    if (this.child === child) {
      this.child = undefined;
    }
  }

  private async prepareThreadWorkspace(cwd: string): Promise<void> {
    await ensureWorkspaceTrust(this.options.codexHome, cwd);
  }

  private profileName(): ProfileName {
    const profile = this.options.profile ?? this.options.role;
    if (!profile) {
      throw new Error("Codex app-server profile is required");
    }
    return profile;
  }

  private async readCodexBinaryVersionBestEffort(): Promise<string> {
    try {
      const result = await execa(this.options.binary, ["--version"], {
        env: buildCodexAppServerEnv(this.options.codexHome, this.options.env ?? process.env),
        reject: false,
        timeout: 1000
      });
      const version = result.stdout.trim() || result.stderr.trim();
      return result.exitCode === 0 && version ? version : "不可用";
    } catch {
      return "不可用";
    }
  }
}

export class ProfileCodexAppServerPool {
  private readonly servers = new Map<ProfileName, CodexAppServer>();

  constructor(private readonly options: ProfileCodexAppServerPoolOptions) {
    const profiles = options.profiles ?? options.roles ?? {};
    for (const profile of Object.keys(profiles)) {
      this.servers.set(
        profile,
        new CodexAppServer({
          profile,
          binary: options.binary,
          codexHome: profiles[profile].codexHome,
          env: options.env,
          requestTimeoutMs: options.requestTimeoutMs,
          clientVersion: options.clientVersion
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
      clientVersion: this.options.clientVersion
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

export class RoleCodexAppServerPool extends ProfileCodexAppServerPool {}
export type RoleCodexAppServerConfig = ProfileCodexAppServerConfig;
export type RoleCodexAppServerPoolOptions = ProfileCodexAppServerPoolOptions;

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
  copyEnv(source, env, "PATH");
  copyEnv(source, env, "HOME");
  copyEnv(source, env, "USER");
  copyEnv(source, env, "LOGNAME");
  copyEnv(source, env, "SHELL");
  copyEnv(source, env, "TMPDIR");
  copyEnv(source, env, "LANG");
  copyEnv(source, env, "LC_ALL");
  copyEnv(source, env, "LC_CTYPE");
  copyEnv(source, env, "TERM");

  env.PATH = env.PATH ?? defaultPath();
  env.CODEX_HOME = path.resolve(codexHome);
  env.NO_COLOR = source.NO_COLOR ?? "1";
  return env;
}

function copyEnv(source: NodeJS.ProcessEnv, target: NodeJS.ProcessEnv, key: string): void {
  if (source[key] !== undefined) {
    target[key] = source[key];
  }
}

function defaultPath(): string {
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}
