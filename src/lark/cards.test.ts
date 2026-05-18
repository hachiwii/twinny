import { describe, expect, it } from "vitest";
import {
  renderTwinnyAgentCard,
  type RenderTwinnyAgentCardOptions
} from "./cards.js";

function createOptions(overrides: Partial<RenderTwinnyAgentCardOptions>): RenderTwinnyAgentCardOptions {
  return {
    status: "working",
    messages: [],
    elapsedMs: 0,
    queueDepth: 0,
    queueNextMessage: false,
    stateKey: "p2p_ou_guest",
    runId: 1,
    ...overrides
  };
}

describe("renderTwinnyAgentCard", () => {
  it("displays append-mode hint by default", () => {
    const card = renderTwinnyAgentCard(createOptions({}));
    expect(JSON.stringify(card)).toContain("追加模式：新消息将被追加至当前任务。");
  });

  it("displays queue-mode hint when queue mode is enabled", () => {
    const card = renderTwinnyAgentCard(createOptions({ queueNextMessage: true }));
    expect(JSON.stringify(card)).toContain("排队模式：新消息将等待当前任务完成后发送。");
  });

  it("displays combined queue hint when queued messages exist in append mode", () => {
    const card = renderTwinnyAgentCard(createOptions({ queueDepth: 2 }));
    expect(JSON.stringify(card)).toContain("追加模式：新消息将和排队消息一起发送。");
  });

  it("puts completed-card mentions at the start of the body", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "finished",
      mentionOpenIds: ["ou_first", "ou_second", "ou_first"],
      finalElements: []
    }));
    const elements = (card.body as { elements: unknown[] }).elements;

    expect(JSON.stringify(elements[0])).toContain("<at id=ou_first></at> <at id=ou_second></at>");
  });
});
