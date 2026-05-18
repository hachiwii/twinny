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

function findButton(card: Record<string, unknown>, label: string): Record<string, unknown> | undefined {
  const queue: unknown[] = [(card.body as { elements: unknown[] }).elements];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (current && typeof current === "object") {
      const element = current as Record<string, unknown>;
      const text = element.text as { content?: string } | undefined;
      if (element.tag === "button" && text?.content === label) {
        return element;
      }
      queue.push(...Object.values(element));
    }
  }
  return undefined;
}

function findTextElement(card: Record<string, unknown>, content: string): Record<string, unknown> | undefined {
  const queue: unknown[] = [(card.body as { elements: unknown[] }).elements];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (current && typeof current === "object") {
      const element = current as Record<string, unknown>;
      const text = element.text as { content?: string } | undefined;
      if (text?.content === content) {
        return element;
      }
      queue.push(...Object.values(element));
    }
  }
  return undefined;
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

  it("uses primary type for the queue button when queue mode is enabled", () => {
    const defaultCard = renderTwinnyAgentCard(createOptions({}));
    expect(findButton(defaultCard, "开启排队")).toMatchObject({ type: "default" });

    const queueCard = renderTwinnyAgentCard(createOptions({ queueNextMessage: true }));
    expect(findButton(queueCard, "关闭排队")).toMatchObject({ type: "primary" });
  });

  it("submits requestUserInput answers through a form button", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "waiting_input",
      waiting: {
        kind: "request_user_input",
        requestId: "request_1",
        questions: [
          {
            id: "choice",
            header: "Choose mode",
            question: "Choose mode",
            isOther: true,
            isSecret: false,
            options: [{ label: "直接实现", description: "按计划改代码并测试。" }]
          }
        ]
      }
    }));
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("\"tag\":\"form\"");
    expect(findButton(card, "提交")).toMatchObject({
      name: "request_user_input_submit",
      action_type: "form_submit",
      value: expect.objectContaining({
        twinny: true,
        action: "request_input_submit"
      })
    });
    expect(findButton(card, "打断")).toMatchObject({
      name: "request_user_input_interrupt",
      behaviors: [
        expect.objectContaining({
          type: "callback",
          value: expect.objectContaining({ action: "request_input_interrupt" })
        })
      ]
    });
  });

  it("displays combined queue hint when queued messages exist in append mode", () => {
    const card = renderTwinnyAgentCard(createOptions({ queueDepth: 2 }));
    expect(JSON.stringify(card)).toContain("追加模式：新消息将和排队消息一起发送。");
  });

  it("adds model, context, and compact token usage to the plain-text elapsed footer", () => {
    const card = renderTwinnyAgentCard(createOptions({
      elapsedMs: 150_000,
      runtimeStats: {
        model: "gpt-5.5",
        effort: "xhigh",
        contextTokens: 57_000,
        contextWindow: 100_000,
        inputTokens: 327_000,
        cachedInputTokens: 294_300,
        outputTokens: 1_210
      }
    }));
    const footer = "已工作 2m30s · gpt-5.5 xhigh · 57% · ↑ 327 K (90% Cached) ↓ 1.21 K";

    expect(JSON.stringify(card)).toContain(footer);
    expect(findTextElement(card, footer)).toMatchObject({
      tag: "div",
      text: expect.objectContaining({
        tag: "plain_text",
        text_color: "grey"
      })
    });
    expect(JSON.stringify(card)).not.toContain("**↑**");
    expect(JSON.stringify(card)).not.toContain("**↓**");
  });

  it("adds plan mode to the elapsed footer when enabled", () => {
    const card = renderTwinnyAgentCard(createOptions({
      elapsedMs: 150_000,
      mode: "plan"
    }));

    expect(JSON.stringify(card)).toContain("已工作 2m30s · Mode: plan");
  });

  it("shows service restart recovery copy in paused-card subtitle", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "paused",
      elapsedMs: 150_000
    }));
    const serialized = JSON.stringify(card);

    expect(card.header).toMatchObject({
      title: { tag: "plain_text", content: "工作中断" },
      subtitle: { tag: "plain_text", content: "服务重启中，任务将在重启后自动恢复" },
      template: "grey"
    });
    expect(serialized).toContain("已工作 2m30s");
    expect(serialized).not.toContain("已暂停，服务重启后继续");
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

  it("omits completed-card process panel when process messages are empty", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "finished",
      messages: [],
      finalElements: []
    }));
    const serialized = JSON.stringify(card);

    expect(serialized).not.toContain("工作过程");
    expect(serialized).not.toContain("暂无进度");
  });
});
