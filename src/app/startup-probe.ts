import type { Logger } from "pino";
import { ConversationManager, type CodexBridge, type LarkResponder, type ConversationRecoveryProbeSnapshot } from "../conversation/manager.js";
import { getProfileCodexHome } from "../profiles/index.js";
import { createConversationRepository, openRuntimeDatabase, type TwinnyDatabase } from "../store/index.js";
import type { RuntimePaths, TwinnyConfig } from "../types.js";
import { createRuntimePaths } from "../config/index.js";
import { WorkspaceManager } from "../workspace/index.js";
import { adaptConversationRepository } from "./wiring.js";

export interface StartupInitializationProbeOptions {
  config: TwinnyConfig;
  paths?: RuntimePaths;
  logger?: Logger;
  openDatabase?: (paths: Pick<RuntimePaths, "sqliteFile">) => TwinnyDatabase;
}

export interface StartupInitializationProbeResult {
  sqliteFile: string;
  recovery: ConversationRecoveryProbeSnapshot;
}

export async function runStartupInitializationProbe(
  options: StartupInitializationProbeOptions
): Promise<StartupInitializationProbeResult> {
  const paths = options.paths ?? createRuntimePaths(options.config.home);
  const db = (options.openDatabase ?? openStartupProbeDatabase)(paths);
  try {
    const repository = createConversationRepository(db);
    const conversation = new ConversationManager({
      config: options.config,
      repository: adaptConversationRepository(repository),
      workspaces: WorkspaceManager.fromRuntimePaths(paths),
      codex: createFailingCodexBridge(),
      lark: createFailingLarkResponder(),
      profiles: { codexHomeFor: (profile) => getProfileCodexHome(options.config, profile) },
      logger: options.logger
    });
    return {
      sqliteFile: paths.sqliteFile,
      recovery: await conversation.probeUnfinishedMessages()
    };
  } finally {
    db.close();
  }
}

export function openStartupProbeDatabase(paths: Pick<RuntimePaths, "sqliteFile">): TwinnyDatabase {
  return openRuntimeDatabase(paths, { readonly: true, migrate: false });
}

export function formatStartupInitializationProbeDetail(result: StartupInitializationProbeResult): string {
  const recovery = result.recovery;
  const parts = [
    result.sqliteFile,
    `unfinished=${recovery.unfinishedMessages}`,
    `recovered=${recovery.recoveredMessages}`,
    `failed=${recovery.failedMessages}`,
    `states=${recovery.stateCount}`,
    `queued=${recovery.queuedMessages}`,
    `processing=${recovery.processingMessages}`
  ];
  if (recovery.compactMessages > 0) {
    parts.push(`compact=${recovery.compactMessages}`);
  }
  return parts.join("; ");
}

function createFailingCodexBridge(): CodexBridge {
  const fail = async (): Promise<never> => {
    throw new Error("startup probe must not call Codex");
  };
  return {
    startThread: fail,
    resumeThread: fail,
    forkThread: fail,
    startTurn: fail,
    compactThread: fail,
    steerTurn: fail,
    interruptTurn: fail,
    readAccountRateLimits: fail
  };
}

function createFailingLarkResponder(): LarkResponder {
  const fail = async (): Promise<never> => {
    throw new Error("startup probe must not call Lark responder");
  };
  return {
    addTypingReaction: fail,
    addCompletedReaction: fail,
    addQueuedReaction: fail,
    removeReaction: fail,
    replyText: fail,
    replyMarkdown: fail,
    replyPost: fail,
    replyFile: fail,
    replyImage: fail,
    sendTextToOpenId: fail,
    sendCardToOpenId: fail,
    sendCardToChatId: fail,
    sendEphemeralCardToChatId: fail,
    forwardThreadToThread: fail,
    replyCard: fail,
    patchCard: fail,
    recallMessage: fail,
    deleteEphemeralMessage: fail,
    getMessageReadOpenIds: fail
  };
}
