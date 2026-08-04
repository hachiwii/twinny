import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { TWINNY_VERSION } from "../version.js";
import { CodexProtocolClient, createInitializeParams } from "./protocol.js";

describe("CodexProtocolClient", () => {
  it("emits an error for unknown responses while open", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const logger = { warn: vi.fn() };
    const protocol = new CodexProtocolClient(readable, writable, {
      logger,
      requestIdPrefix: "twinny-test"
    });
    const errors = vi.fn();
    protocol.on("error", errors);
    protocol.start();

    readable.write(JSON.stringify({ id: "twinny-test-1", result: {} }) + "\n");
    readable.end();

    await expect(protocol.waitForClose()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: "CODEX_UNKNOWN_RESPONSE" }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs and discards a late response after the request times out", async () => {
    vi.useFakeTimers();
    try {
      const readable = new PassThrough();
      const writable = new PassThrough();
      const logger = { warn: vi.fn() };
      const protocol = new CodexProtocolClient(readable, writable, {
        logger,
        requestIdPrefix: "twinny-test",
        requestTimeoutMs: 10
      });
      const errors = vi.fn();
      const responses = vi.fn();
      protocol.on("error", errors);
      protocol.on("response", responses);
      protocol.start();

      const request = expect(protocol.request("turn/interrupt")).rejects.toMatchObject({
        code: "CODEX_REQUEST_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(10);
      await request;

      readable.write(JSON.stringify({ id: "twinny-test-1", result: {} }) + "\n");
      readable.end();

      await expect(protocol.waitForClose()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        { requestId: "twinny-test-1", responseHasError: false },
        "discarded late Codex response for a request that is no longer pending"
      );
      expect(responses).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores late inbound messages after local close", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const protocol = new CodexProtocolClient(readable, writable, {
      requestIdPrefix: "twinny-test"
    });
    const errors = vi.fn();
    protocol.on("error", errors);
    protocol.start();

    const request = protocol.request("turn/start").catch((error: unknown) => error);
    protocol.close();
    readable.write(JSON.stringify({ id: "twinny-test-1", result: {} }) + "\n");
    readable.end();

    await expect(request).resolves.toMatchObject({ code: "CODEX_PROTOCOL_CLOSED" });
    await expect(protocol.waitForClose()).resolves.toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
  });

  it("uses the injected Twinny version in initialize params by default", () => {
    expect(createInitializeParams().clientInfo.version).toBe(TWINNY_VERSION);
  });

  it("accepts explicit initialize client info", () => {
    expect(createInitializeParams({ name: "codex-tui", title: null, version: "1.2.3" }).clientInfo).toEqual({
      name: "codex-tui",
      title: null,
      version: "1.2.3"
    });
  });
});
