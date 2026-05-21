import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { ensureGuestWorkspaceProjectTrusted } from "../roles/index.js";
import type { RoleName } from "../types.js";
import { CodexProtocolClient, createInitializeParams, type InitializeResponse } from "./protocol.js";
import {
  forkCodexThread,
  injectCodexThreadItems,
  resumeCodexThread,
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
  role: RoleName;
  binary: string;
  codexHome: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  clientVersion?: string;
  stopTimeoutMs?: number;
}

export interface RoleCodexAppServerConfig {
  role: RoleName;
  codexHome: string;
}

export interface RoleCodexAppServerPoolOptions {
  binary: string;
  roles: Record<RoleName, { codexHome: string }>;
  requestTimeoutMs?: number;
  clientVersion?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CodexAppServerEvents {
  stderr: [chunk: string];
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
    if (this.protocolClient) {
      this.initializeResponse = await this.protocolClient.initialize(createInitializeParams(this.options.clientVersion));
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
      requestIdPrefix: `twinny-${this.options.role}`
    });
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
    return this.initializeResponse;
  }

  async startThread(cwd: string): Promise<ThreadStartResponse> {
    await this.prepareThreadWorkspace(cwd);
    return startCodexThread(this.protocol, { cwd });
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
    if (this.options.role !== "guest") {
      return;
    }
    await ensureGuestWorkspaceProjectTrusted(this.options.codexHome, cwd);
  }
}

export class RoleCodexAppServerPool {
  private readonly servers = new Map<RoleName, CodexAppServer>();

  constructor(private readonly options: RoleCodexAppServerPoolOptions) {
    for (const role of Object.keys(options.roles) as RoleName[]) {
      this.servers.set(
        role,
        new CodexAppServer({
          role,
          binary: options.binary,
          codexHome: options.roles[role].codexHome,
          env: options.env,
          requestTimeoutMs: options.requestTimeoutMs,
          clientVersion: options.clientVersion
        })
      );
    }
  }

  async startAll(): Promise<Record<RoleName, InitializeResponse>> {
    const owner = this.get("owner").start();
    const guest = this.get("guest").start();
    const [ownerResponse, guestResponse] = await Promise.all([owner, guest]);
    return {
      owner: ownerResponse,
      guest: guestResponse
    };
  }

  get(role: RoleName): CodexAppServer {
    const server = this.servers.get(role);
    if (!server) {
      throw new Error(`No Codex app-server configured for role ${role}`);
    }
    return server;
  }

  async restart(role: RoleName): Promise<InitializeResponse> {
    return this.get(role).start();
  }

  async stopAll(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    await Promise.all(Array.from(this.servers.values(), (server) => server.stop(signal)));
  }
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
