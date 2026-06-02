import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTwinnyConfig } from "../config/index.js";
import type { CodexAppServer, ProfileCodexAppServerPool } from "../codex/index.js";
import type { TelemetryClient } from "../telemetry/index.js";
import type { ProfileName } from "../types.js";
import { startupLarkFeatureSetDefinitions, TwinnyRuntime } from "./wiring.js";

interface RuntimeInternals {
  codexPool?: ProfileCodexAppServerPool;
  attachCodexAppServerListeners(profile: ProfileName, server: CodexAppServer): void;
  stopCodexPool(signal: NodeJS.Signals): Promise<void>;
}

describe("TwinnyRuntime Codex app-server exit telemetry", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports unexpected Codex app-server exits", () => {
    const telemetry = createTelemetry();
    const logger = createLogger();
    const { runtime, server } = createRuntimeWithServer({ telemetry, logger });

    server.emit("exit", 127, null);

    expect(logger.error).toHaveBeenCalledWith(
      { profile: "guest", code: 127, signal: null },
      "codex app-server exited"
    );
    expect(telemetry.captureError).toHaveBeenCalledWith(expect.any(Error), {
      errorType: "codex_app_server",
      errorSite: "runtime.codexAppServer.exit",
      operation: "codex_app_server_exit",
      fatal: false,
      properties: { profile: "guest", code: 127, signal: null }
    });
    expect((runtime as unknown as RuntimeInternals).codexPool).toBeUndefined();
  });

  it("does not report Codex app-server exits caused by runtime stop", async () => {
    const telemetry = createTelemetry();
    const logger = createLogger();
    const { runtime, server } = createRuntimeWithServer({ telemetry, logger });
    const stopAll = vi.fn(async (signal: NodeJS.Signals) => {
      server.emit("exit", null, signal);
    });
    (runtime as unknown as RuntimeInternals).codexPool = createCodexPool(["guest"], stopAll);

    await runtime.stop("SIGTERM");

    expect(stopAll).toHaveBeenCalledWith("SIGTERM");
    expect(telemetry.captureError).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { profile: "guest", code: null, signal: "SIGTERM" },
      "codex app-server stopped intentionally"
    );
  });

  it("does not report Codex app-server exits caused by intentional pool stop", async () => {
    const telemetry = createTelemetry();
    const logger = createLogger();
    const { runtime, server } = createRuntimeWithServer({ telemetry, logger });
    const stopAll = vi.fn(async (signal: NodeJS.Signals) => {
      server.emit("exit", null, signal);
    });
    const internals = runtime as unknown as RuntimeInternals;
    internals.codexPool = createCodexPool(["guest"], stopAll);

    await internals.stopCodexPool("SIGTERM");

    expect(stopAll).toHaveBeenCalledWith("SIGTERM");
    expect(telemetry.captureError).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { profile: "guest", code: null, signal: "SIGTERM" },
      "codex app-server stopped intentionally"
    );
  });

  it("only checks auto activation event subscriptions for enabled greeting targets", () => {
    expect(autoActivationEvents(createConfig({
      permissions: { p2pDefaultProfile: "guest" },
      greeting: { p2p: { mode: "none" } }
    }))).toEqual([]);
    expect(autoActivationEvents(createConfig({
      permissions: { p2pDefaultProfile: "guest" },
      greeting: { p2p: { mode: "text", message: "Welcome" } }
    }))).toEqual(["p2p_chat_create"]);
    expect(autoActivationEvents(createConfig({
      permissions: { groupDefaultProfile: "guest", groupDefaultMode: "all_at" },
      greeting: { group: { mode: "codex_turn", message: "Introduce Twinny" } }
    }))).toEqual(["im.chat.member.bot.added_v1"]);
    expect(autoActivationEvents(createConfig({
      permissions: {
        p2pDefaultProfile: "guest",
        groupDefaultProfile: "guest",
        groupDefaultMode: "owner_at"
      },
      greeting: {
        p2p: { mode: "text", message: "Welcome" },
        group: { mode: "text", message: "Welcome" }
      }
    }))).toEqual(["p2p_chat_create", "im.chat.member.bot.added_v1"]);
    expect(autoActivationEvents(createConfig({
      permissions: { groupDefaultProfile: "guest", groupDefaultMode: "none" },
      greeting: { group: { mode: "text", message: "Welcome" } }
    }))).toEqual([]);
  });

  function createRuntimeWithServer(options: { telemetry: ReturnType<typeof createTelemetry>; logger: Logger }): {
    runtime: TwinnyRuntime;
    server: CodexAppServer;
  } {
    const runtime = new TwinnyRuntime(createConfig(), {
      logger: options.logger,
      telemetry: options.telemetry,
      disableHeartbeat: true
    });
    const server = new EventEmitter() as CodexAppServer;
    (runtime as unknown as RuntimeInternals).attachCodexAppServerListeners("guest", server);
    return { runtime, server };
  }

  function createConfig(overrides: Partial<Pick<Parameters<typeof createTwinnyConfig>[0], "permissions" | "greeting">> = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-runtime-"));
    tempDirs.push(home);
    return createTwinnyConfig({
      home,
      homeRandom: "0123456789abcdef0123456789abcdef",
      auth: { larkAppId: "cli_app", larkBrand: "feishu", ownerOpenId: "ou_owner", displayName: "Owner User" },
      telemetry: { enabled: false },
      ...overrides
    });
  }
});

function autoActivationEvents(config: ReturnType<typeof createTwinnyConfig>): readonly string[] {
  return startupLarkFeatureSetDefinitions(config).find((definition) => definition.key === "auto_activation")?.events ?? [];
}

function createTelemetry() {
  return {
    runtimeId: "runtime_1",
    capture: vi.fn(),
    captureError: vi.fn(),
    shutdown: vi.fn(),
    hashId: vi.fn((kind: string, raw: string | null | undefined) => (raw ? `hashed:${kind}:${raw}` : null))
  } satisfies TelemetryClient;
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Logger;
}

function createCodexPool(
  profiles: ProfileName[],
  stopAll: (signal: NodeJS.Signals) => Promise<void>
): ProfileCodexAppServerPool {
  return {
    listProfiles: () => profiles,
    stopAll
  } as unknown as ProfileCodexAppServerPool;
}
