import type { Logger } from "pino";
import type { CodexBridge } from "../conversation/manager.js";
import { TwinnyError } from "../errors.js";
import { logger as defaultLogger } from "../observability/logs.js";
import type { HarnessKind } from "../types.js";
import type { ClaudeCodeHarness } from "./claude.js";

export interface HarnessRouterOptions {
  codex: CodexBridge;
  claude: ClaudeCodeHarness;
  defaultHarness: HarnessKind;
  /**
   * Resolves the persisted harness of a thread (typically from the threads
   * table). Used as a fallback for threads created before the current
   * process started.
   */
  resolveThreadHarness?: (threadId: string) => HarnessKind | undefined;
  logger?: Logger;
}

export function harnessUnsupportedError(feature: string, reason: string): TwinnyError {
  return new TwinnyError(`Claude Code harness 不支持${feature}：${reason}`, "HARNESS_UNSUPPORTED");
}

/**
 * Routes every Codex bridge call to the harness that owns the target thread.
 *
 * - Thread-scoped calls route by thread id (in-memory map first, persisted
 *   thread records as fallback, Codex as the final default so existing
 *   deployments keep their exact behavior).
 * - Profile/account-scoped calls (version probe, account rate limits, thread
 *   list/search over Codex rollouts) always go to Codex.
 * - Calls a Claude Code thread cannot satisfy either degrade to a safe no-op
 *   (goal reads, thread naming) or throw a typed, user-explainable error.
 */
export function createHarnessRouter(options: HarnessRouterOptions): CodexBridge {
  const log = options.logger ?? defaultLogger;
  const codex = options.codex;
  const claude = options.claude;
  const threadHarness = new Map<string, HarnessKind>();

  const resolve = (threadId: string): HarnessKind => {
    const known = threadHarness.get(threadId);
    if (known) {
      return known;
    }
    let persisted: HarnessKind | undefined;
    try {
      persisted = options.resolveThreadHarness?.(threadId);
    } catch (error) {
      log.warn({ error, threadId }, "failed to resolve persisted thread harness; defaulting to codex");
    }
    if (persisted) {
      threadHarness.set(threadId, persisted);
      return persisted;
    }
    // Unknown thread: default to Codex (pre-harness behavior) without
    // caching, so a record persisted later can still win.
    return "codex";
  };

  const remember = (threadId: string, harness: HarnessKind): void => {
    threadHarness.set(threadId, harness);
  };

  const router: CodexBridge = {
    threadHarness: (threadId) => threadHarness.get(threadId) ?? options.resolveThreadHarness?.(threadId),

    startThread: async (params) => {
      const harness = params.harness ?? options.defaultHarness;
      const result = harness === "claude" ? await claude.startThread(params) : await codex.startThread(params);
      remember(result.threadId, harness);
      return result;
    },

    resumeThread: async (params) => {
      const harness = resolve(params.threadId);
      const result = harness === "claude" ? await claude.resumeThread(params) : await codex.resumeThread(params);
      remember(result.threadId, harness);
      return result;
    },

    forkThread: async (params) => {
      const harness = resolve(params.threadId);
      const result = harness === "claude" ? await claude.forkThread(params) : await codex.forkThread(params);
      remember(result.threadId, harness);
      return result;
    },

    readThread: async (params) => {
      if (resolve(params.threadId) === "claude") {
        throw harnessUnsupportedError("读取 thread 历史", "Claude Code CLI 没有读取会话内容的接口");
      }
      if (!codex.readThread) {
        throw new TwinnyError("Codex bridge does not support thread/read", "CODEX_UNSUPPORTED");
      }
      return codex.readThread(params);
    },

    listThreads: async (params) => {
      if (!codex.listThreads) {
        throw new TwinnyError("Codex bridge does not support thread/list", "CODEX_UNSUPPORTED");
      }
      return codex.listThreads(params);
    },

    searchThreads: async (params) => {
      if (!codex.searchThreads) {
        throw new TwinnyError("Codex bridge does not support thread/search", "CODEX_UNSUPPORTED");
      }
      return codex.searchThreads(params);
    },

    rollbackThread: async (params) => {
      if (resolve(params.threadId) === "claude") {
        throw harnessUnsupportedError("/rewind 回退", "Claude Code CLI 没有删除会话最近若干轮的接口");
      }
      if (!codex.rollbackThread) {
        throw new TwinnyError("Codex bridge does not support thread/rollback", "CODEX_UNSUPPORTED");
      }
      return codex.rollbackThread(params);
    },

    injectThreadItems: async (params) => {
      if (resolve(params.threadId) === "claude") {
        await claude.injectThreadItems(params);
        return;
      }
      if (!codex.injectThreadItems) {
        throw new TwinnyError("Codex bridge does not support thread/inject_items", "CODEX_UNSUPPORTED");
      }
      await codex.injectThreadItems(params);
    },

    unsubscribeThread: async (params) => {
      if (resolve(params.threadId) === "claude") {
        await claude.unsubscribeThread(params);
        return;
      }
      await codex.unsubscribeThread?.(params);
    },

    startTurn: async (params) => {
      if (resolve(params.threadId) === "claude") {
        return claude.startTurn(params);
      }
      return codex.startTurn(params);
    },

    compactThread: async (params) => {
      if (resolve(params.threadId) === "claude") {
        return claude.compactThread(params);
      }
      return codex.compactThread(params);
    },

    steerTurn: async (params) => {
      if (resolve(params.threadId) === "claude") {
        await claude.steerTurn(params);
        return;
      }
      await codex.steerTurn(params);
    },

    interruptTurn: async (params) => {
      if (resolve(params.threadId) === "claude") {
        await claude.interruptTurn(params);
        return;
      }
      await codex.interruptTurn(params);
    },

    readCodexVersion: (params) => {
      if (!codex.readCodexVersion) {
        return "不可用";
      }
      return codex.readCodexVersion(params);
    },

    readAccountRateLimits: async (params) => {
      if (!codex.readAccountRateLimits) {
        throw new TwinnyError("Codex bridge does not support account/rateLimits/read", "CODEX_UNSUPPORTED");
      }
      return codex.readAccountRateLimits(params);
    },

    setThreadGoal: async (params) => {
      if (resolve(params.threadId) === "claude") {
        throw harnessUnsupportedError("goal 任务", "goal 状态机依赖 Codex app-server 的 thread/goal 协议");
      }
      if (!codex.setThreadGoal) {
        throw new TwinnyError("Codex bridge does not support thread/goal/set", "CODEX_UNSUPPORTED");
      }
      return codex.setThreadGoal(params);
    },

    getThreadGoal: async (params) => {
      if (resolve(params.threadId) === "claude") {
        return null;
      }
      if (!codex.getThreadGoal) {
        return null;
      }
      return codex.getThreadGoal(params);
    },

    clearThreadGoal: async (params) => {
      if (resolve(params.threadId) === "claude") {
        return;
      }
      await codex.clearThreadGoal?.(params);
    },

    setThreadName: async (params) => {
      if (resolve(params.threadId) === "claude") {
        // Claude Code sessions have no server-side display name; Twinny keeps
        // thread names in its own store, so this is a safe no-op.
        return;
      }
      await codex.setThreadName?.(params);
    },

    readThreadMetadata: async (params) => {
      if (resolve(params.threadId) === "claude") {
        throw harnessUnsupportedError("读取 thread 元数据", "Claude Code CLI 没有读取会话元数据的接口");
      }
      if (!codex.readThreadMetadata) {
        throw new TwinnyError("Codex bridge does not support thread metadata reads", "CODEX_UNSUPPORTED");
      }
      return codex.readThreadMetadata(params);
    },

    runGoal: async (params) => {
      if (resolve(params.threadId) === "claude") {
        throw harnessUnsupportedError("goal 任务", "goal 状态机依赖 Codex app-server 的 thread/goal 协议");
      }
      if (!codex.runGoal) {
        throw new TwinnyError("Codex bridge does not support goal runs", "CODEX_UNSUPPORTED");
      }
      return codex.runGoal(params);
    },

    resumeGoal: async (params) => {
      if (resolve(params.threadId) === "claude") {
        throw harnessUnsupportedError("goal 任务", "goal 状态机依赖 Codex app-server 的 thread/goal 协议");
      }
      if (!codex.resumeGoal) {
        throw new TwinnyError("Codex bridge does not support goal resumes", "CODEX_UNSUPPORTED");
      }
      return codex.resumeGoal(params);
    }
  };

  return router;
}
