import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { TWINNY_VERSION } from "../version.js";
import { CodexProtocolClient, createInitializeParams } from "./protocol.js";

describe("CodexProtocolClient", () => {
  it("emits an error for unknown responses while open", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const protocol = new CodexProtocolClient(readable, writable);
    const errors = vi.fn();
    protocol.on("error", errors);
    protocol.start();

    readable.write(JSON.stringify({ id: "unknown", result: {} }) + "\n");
    readable.end();

    await expect(protocol.waitForClose()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: "CODEX_UNKNOWN_RESPONSE" }));
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
});
