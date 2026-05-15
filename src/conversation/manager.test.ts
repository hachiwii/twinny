import { describe, expect, it, vi } from "vitest";
import { TwinnyError } from "../errors.js";
import type { ConversationRecord, TwinnyConfig } from "../types.js";
import { ConversationManager } from "./manager.js";

const config: TwinnyConfig = {
  home: "/tmp/twinny",
  codex: { binary: "codex", appServerListen: "stdio://" },
  lark: {
    appId: "cli_xxx",
    appSecretRef: "keychain:twinny/lark/app_secret",
    eventKey: "im.message.receive_v1",
    identity: "bot",
    workingReaction: "Typing"
  },
  autoApproval: { enabled: false, pollIntervalMs: 60_000 },
  owner: { openId: "ou_owner", displayName: "Owner" },
  roles: {
    owner: { codexHome: "/tmp/twinny/roles/owner/codex" },
    guest: { codexHome: "/tmp/twinny/roles/guest/codex" }
  }
};

describe("ConversationManager", () => {
  it("serializes messages for the same conversation and manages typing reaction", async () => {
    const rows = new Map<string, ConversationRecord>();
    const order: string[] = [];
    const startThread = vi.fn(async () => ({ threadId: "thread_1" }));
    const resumeThread = vi.fn(async ({ threadId }) => ({ threadId }));
    const manager = new ConversationManager({
      config,
      repository: {
        findByConversationKey: (key) => rows.get(key) ?? null,
        create: (record) => {
          const row: ConversationRecord = {
            id: rows.size + 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ...record
          };
          rows.set(record.conversationKey, row);
          return row;
        },
        updateThreadBinding: (key, update) => {
          const existing = rows.get(key);
          if (!existing) {
            throw new Error("missing conversation");
          }
          const row = { ...existing, ...update, updatedAt: Date.now() };
          rows.set(key, row);
          return row;
        }
      },
      workspaces: {
        ensureWorkspace: (key) => `/tmp/twinny/workspaces/${key}`
      },
      roles: {
        codexHomeFor: (role) => config.roles[role].codexHome
      },
      codex: {
        startThread,
        resumeThread,
        startTurn: vi.fn(async ({ input }) => {
          order.push(input);
          return { threadId: "thread_1", text: `reply ${input}`, status: "completed" as const };
        })
      },
      lark: {
        addTypingReaction: vi.fn(async (messageId) => ({ messageId, reactionId: `r_${messageId}` })),
        removeReaction: vi.fn(async () => undefined),
        replyText: vi.fn(async () => undefined)
      }
    });

    await Promise.all([
      manager.handleIncoming(message("m1", "first")),
      manager.handleIncoming(message("m2", "second"))
    ]);

    expect(order).toEqual(["first", "second"]);
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(resumeThread).toHaveBeenCalledTimes(1);
    expect(rows.get("p2p:ou_guest")?.name).toBe("Guest User");
  });

  it("ignores duplicate message ids", async () => {
    const startTurn = vi.fn(async () => ({ threadId: "thread_1", text: "reply", status: "completed" as const }));
    const manager = new ConversationManager({
      config,
      repository: {
        findByConversationKey: () => ({
          id: 1,
          conversationKey: "p2p:ou_guest",
          type: "p2p",
          chatId: "ou_guest",
          name: "Guest User",
          role: "guest",
          codexThreadId: "thread_1",
          workspace: "/tmp/twinny/workspaces/p2p:ou_guest",
          roleCodexHome: "/tmp/twinny/roles/guest/codex",
          createdAt: Date.now(),
          updatedAt: Date.now()
        }),
        create: () => {
          throw new Error("unexpected create");
        },
        updateThreadBinding: () => {
          throw new Error("unexpected update");
        }
      },
      workspaces: { ensureWorkspace: () => "/tmp/twinny/workspaces/p2p:ou_guest" },
      roles: { codexHomeFor: (role) => config.roles[role].codexHome },
      codex: {
        startThread: async () => ({ threadId: "thread_1" }),
        resumeThread: async ({ threadId }) => ({ threadId }),
        startTurn
      },
      lark: {
        addTypingReaction: async (messageId) => ({ messageId, reactionId: "r1" }),
        removeReaction: async () => undefined,
        replyText: async () => undefined
      }
    });

    await manager.handleIncoming(message("m1", "first"));
    await manager.handleIncoming(message("m1", "first again"));

    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it("replaces a persisted thread when Codex no longer has the rollout", async () => {
    let row: ConversationRecord = {
      id: 1,
      conversationKey: "p2p:ou_guest",
      type: "p2p",
      chatId: "ou_guest",
      name: "Guest User",
      role: "guest",
      codexThreadId: "thread_missing",
      workspace: "/tmp/twinny/workspaces/p2p:ou_guest",
      roleCodexHome: "/tmp/twinny/roles/guest/codex",
      createdAt: 100,
      updatedAt: 100
    };
    const startTurn = vi.fn(async ({ threadId, onAgentMessage }) => {
      await onAgentMessage?.({ id: "agent_1", text: "reply" });
      return { threadId, text: "reply", status: "completed" as const };
    });
    const replyText = vi.fn(async () => undefined);
    const manager = new ConversationManager({
      config,
      repository: {
        findByConversationKey: () => row,
        create: () => {
          throw new Error("unexpected create");
        },
        updateThreadBinding: (_key, update) => {
          row = { ...row, ...update, updatedAt: 200 };
          return row;
        }
      },
      workspaces: { ensureWorkspace: () => "/tmp/twinny/workspaces/p2p:ou_guest" },
      roles: { codexHomeFor: (role) => config.roles[role].codexHome },
      codex: {
        startThread: vi.fn(async () => ({ threadId: "thread_replacement" })),
        resumeThread: vi.fn(async () => {
          throw new TwinnyError("no rollout found for thread id thread_missing", "CODEX_REQUEST_FAILED", {
            code: -32600,
            message: "no rollout found for thread id thread_missing"
          });
        }),
        startTurn
      },
      lark: {
        addTypingReaction: async (messageId) => ({ messageId, reactionId: "r1" }),
        removeReaction: async () => undefined,
        replyText
      }
    });

    await manager.handleIncoming(message("m1", "first"));

    expect(row.codexThreadId).toBe("thread_replacement");
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread_replacement" }));
    expect(replyText).toHaveBeenNthCalledWith(1, "m1", expect.stringMatching(/^WARN: .*previous context/));
    expect(replyText).toHaveBeenNthCalledWith(2, "m1", "reply");
  });

  it("sends completed agentMessage items and skips the turn-finished aggregate reply", async () => {
    const startTurn = vi.fn(async ({ threadId, onAgentMessage }) => {
      await onAgentMessage?.({ id: "agent_1", text: "first item" });
      await onAgentMessage?.({ id: "agent_2", text: "second item" });
      return { threadId, text: "final aggregate should not be sent", status: "completed" as const };
    });
    const replyText = vi.fn(async () => undefined);
    const manager = new ConversationManager({
      config,
      repository: {
        findByConversationKey: () => ({
          id: 1,
          conversationKey: "p2p:ou_guest",
          type: "p2p",
          chatId: "ou_guest",
          name: "Guest User",
          role: "guest",
          codexThreadId: "thread_1",
          workspace: "/tmp/twinny/workspaces/p2p:ou_guest",
          roleCodexHome: "/tmp/twinny/roles/guest/codex",
          createdAt: Date.now(),
          updatedAt: Date.now()
        }),
        create: () => {
          throw new Error("unexpected create");
        },
        updateThreadBinding: () => {
          throw new Error("unexpected update");
        }
      },
      workspaces: { ensureWorkspace: () => "/tmp/twinny/workspaces/p2p:ou_guest" },
      roles: { codexHomeFor: (role) => config.roles[role].codexHome },
      codex: {
        startThread: async () => ({ threadId: "thread_1" }),
        resumeThread: async ({ threadId }) => ({ threadId }),
        startTurn
      },
      lark: {
        addTypingReaction: async (messageId) => ({ messageId, reactionId: "r1" }),
        removeReaction: async () => undefined,
        replyText
      }
    });

    await manager.handleIncoming(message("m1", "first"));

    expect(replyText).toHaveBeenCalledTimes(2);
    expect(replyText).toHaveBeenNthCalledWith(1, "m1", "first item");
    expect(replyText).toHaveBeenNthCalledWith(2, "m1", "second item");
    expect(replyText).not.toHaveBeenCalledWith("m1", "final aggregate should not be sent");
  });
});

function message(messageId: string, text: string) {
  return {
      eventId: `e_${messageId}`,
      messageId,
      chatId: "oc_ignored",
      chatType: "p2p",
      messageType: "text",
      senderOpenId: "ou_guest",
      senderName: "Guest User",
      text,
      raw: {}
  };
}
