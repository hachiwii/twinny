import { describe, expect, it } from "vitest";
import {
  markdownElement,
  renderTwinnyAgentCard,
  renderTwinnyThreadSummaryCard,
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

function cardSummary(card: Record<string, unknown>): string | undefined {
  return (card.config as { summary?: { content?: string } }).summary?.content;
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

function findElementByTag(card: Record<string, unknown>, tag: string): Record<string, unknown> | undefined {
  return findElementsByTag(card, tag)[0];
}

function findElementsByTag(card: Record<string, unknown>, tag: string): Record<string, unknown>[] {
  const matches: Record<string, unknown>[] = [];
  const queue: unknown[] = [(card.body as { elements: unknown[] }).elements];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (current && typeof current === "object") {
      const element = current as Record<string, unknown>;
      if (element.tag === tag) {
        matches.push(element);
      }
      queue.push(...Object.values(element));
    }
  }
  return matches;
}

describe("markdownElement", () => {
  it("removes list indentation from fenced code blocks before rendering Lark card markdown", () => {
    const element = markdownElement([
      "3. 先跑最小构建",
      "   Android 通常是：",
      "   ```bash",
      "   ./gradlew assembleDebug",
      "   ./gradlew test",
      "   ```"
    ].join("\n"));

    expect(element.content).toBe([
      "3. 先跑最小构建",
      "   Android 通常是：",
      "```bash",
      "./gradlew assembleDebug",
      "./gradlew test",
      "```"
    ].join("\n"));
  });

  it("preserves code indentation after removing only the shared fence prefix", () => {
    const element = markdownElement([
      "1. 示例",
      "    ```ts",
      "      const value = 1;",
      "        return value;",
      "    ```"
    ].join("\n"));

    expect(element.content).toBe([
      "1. 示例",
      "```ts",
      "  const value = 1;",
      "    return value;",
      "```"
    ].join("\n"));
  });

  it("leaves unindented fenced code blocks unchanged", () => {
    const markdown = [
      "```bash",
      "./gradlew assembleDebug",
      "```"
    ].join("\n");

    expect(markdownElement(markdown).content).toBe(markdown);
  });
});

describe("renderTwinnyAgentCard", () => {
  const samplePlanText = [
    "# 最小计划",
    "",
    "## Summary",
    "确认当前处于 plan mode，仅产出计划。",
    "",
    "## Key Changes",
    "不修改文件，不运行命令。",
    "",
    "## 任意 Part",
    "不假设固定的计划分段名称。"
  ].join("\n");
  const untitledPlanText = [
    "## Summary",
    "原始摘要",
    "",
    "## Key Changes",
    "保持 Codex 原始文本。"
  ].join("\n");

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

    expect(cardSummary(card)).toBe("[需要交互] 1 个问题待回答");
    expect(serialized).toContain("\"tag\":\"form\"");
    expect(findElementByTag(card, "select_static")).toMatchObject({
      initial_index: 1
    });
    expect(findButton(card, "提交")).toMatchObject({
      name: "request_user_input_submit",
      action_type: "form_submit",
      value: expect.objectContaining({
        twinny: true,
        action: "request_input_submit"
      })
    });
    expect(findButton(card, "跳过")).toMatchObject({
      name: "request_user_input_interrupt",
      behaviors: [
        expect.objectContaining({
          type: "callback",
          value: expect.objectContaining({ action: "request_input_interrupt" })
        })
      ]
    });
  });

  it("renders skipped requestUserInput cards without form controls or action buttons", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "interrupted_input",
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

    expect(card.header).toMatchObject({
      title: { tag: "plain_text", content: "已跳过问题" },
      subtitle: { tag: "plain_text", content: "" },
      template: "grey"
    });
    expect(serialized).toContain("Choose mode");
    expect(findElementByTag(card, "select_static")).toBeUndefined();
    expect(findElementByTag(card, "input")).toBeUndefined();
    expect(findButton(card, "提交")).toBeUndefined();
    expect(findButton(card, "跳过")).toBeUndefined();
  });

  it("renders waiting plan markdown as title and separated parts", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "waiting_plan",
      waiting: {
        kind: "plan",
        planText: samplePlanText
      }
    }));
    const serialized = JSON.stringify(card);

    expect(cardSummary(card)).toBe("[待确认计划] 最小计划");
    expect(card.header).toMatchObject({
      title: { tag: "plain_text", content: "最小计划" },
      subtitle: { tag: "plain_text", content: "确认计划" },
      template: "wathet"
    });
    expect(serialized).toContain("#### Summary");
    expect(serialized).toContain("#### Key Changes");
    expect(serialized).toContain("#### 任意 Part");
    expect(findElementsByTag(card, "hr")).toHaveLength(2);
    expect(serialized).not.toContain("查看完整计划");
    expect(findElementByTag(card, "input")).toMatchObject({
      name: "plan_implement_instruction",
      placeholder: {
        tag: "plain_text",
        content: "补充提交指令（可选）"
      }
    });
    expect(findButton(card, "实现")).toMatchObject({
      name: "plan_implement_submit",
      action_type: "form_submit",
      value: expect.objectContaining({ action: "plan_implement" })
    });
    expect(findButton(card, "拒绝")).toMatchObject({
      behaviors: [
        expect.objectContaining({
          type: "callback",
          value: expect.objectContaining({ action: "plan_interrupt" })
        })
      ]
    });
  });

  it("renders untitled waiting plans with the fixed header and raw markdown body", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "waiting_plan",
      waiting: {
        kind: "plan",
        planText: untitledPlanText
      }
    }));
    const serialized = JSON.stringify(card);

    expect(cardSummary(card)).toBe("[待确认计划] 确认计划");
    expect(card.header).toMatchObject({
      title: { tag: "plain_text", content: "确认计划" },
      subtitle: { tag: "plain_text", content: "" },
      template: "wathet"
    });
    expect(serialized).toContain("## Summary");
    expect(serialized).toContain("## Key Changes");
    expect(serialized).not.toContain("#### Summary");
    expect(serialized).not.toContain("查看完整计划");
    expect(findElementsByTag(card, "hr")).toHaveLength(0);
    expect(findButton(card, "实现")).toBeDefined();
  });

  it("renders rejected plan cards with a stable title and collapsed remaining parts", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "interrupted_plan",
      waiting: {
        kind: "plan",
        planText: samplePlanText
      }
    }));
    const serialized = JSON.stringify(card);

    expect(card.header).toMatchObject({
      title: { tag: "plain_text", content: "最小计划" },
      subtitle: { tag: "plain_text", content: "计划被拒绝" },
      template: "grey"
    });
    expect(serialized).toContain("#### Summary");
    expect(serialized).toContain("确认当前处于 plan mode");
    expect(serialized).toContain("查看完整计划");
    expect(serialized).toContain("#### Key Changes");
    expect(serialized).toContain("#### 任意 Part");
    expect(findElementsByTag(card, "hr")).toHaveLength(0);
    expect(findButton(card, "实现")).toBeUndefined();
    expect(findButton(card, "拒绝")).toBeUndefined();
  });

  it("renders untitled terminal plan cards without folding the raw markdown body", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "accepted_plan",
      waiting: {
        kind: "plan",
        planText: untitledPlanText
      }
    }));
    const serialized = JSON.stringify(card);

    expect(card.header).toMatchObject({
      title: { tag: "plain_text", content: "计划已确认" },
      subtitle: { tag: "plain_text", content: "" },
      template: "turquoise"
    });
    expect(serialized).toContain("## Summary");
    expect(serialized).toContain("## Key Changes");
    expect(serialized).not.toContain("#### Summary");
    expect(serialized).not.toContain("查看完整计划");
    expect(findElementsByTag(card, "hr")).toHaveLength(0);
    expect(findButton(card, "实现")).toBeUndefined();
    expect(findButton(card, "拒绝")).toBeUndefined();
  });

  it("renders accepted plan cards with a turquoise header and collapsed remaining parts", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "accepted_plan",
      waiting: {
        kind: "plan",
        planText: samplePlanText
      }
    }));
    const serialized = JSON.stringify(card);

    expect(card.header).toMatchObject({
      title: { tag: "plain_text", content: "最小计划" },
      subtitle: { tag: "plain_text", content: "计划已确认" },
      template: "turquoise"
    });
    expect(serialized).toContain("#### Summary");
    expect(serialized).toContain("查看完整计划");
    expect(serialized).toContain("#### Key Changes");
    expect(findElementsByTag(card, "hr")).toHaveLength(0);
    expect(findButton(card, "实现")).toBeUndefined();
    expect(findButton(card, "拒绝")).toBeUndefined();
  });

  it("displays combined queue hint when queued messages exist in append mode", () => {
    const card = renderTwinnyAgentCard(createOptions({ queueDepth: 2 }));
    expect(JSON.stringify(card)).toContain("追加模式：新消息将和排队消息一起发送。");
  });

  it("renders failed errors as schema-valid markdown", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "failed",
      error: "Codex app-server reported an error"
    }));
    const markdownElements = findElementsByTag(card, "markdown");

    expect(card.header).toMatchObject({
      title: { tag: "plain_text", content: "发生错误" },
      template: "red"
    });
    expect(markdownElements).toContainEqual(
      expect.objectContaining({
        content: "- [ERROR] Codex app-server reported an error"
      })
    );
    expect(markdownElements.some((element) => Object.hasOwn(element, "text_color"))).toBe(false);
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

    expect(JSON.stringify(card)).toContain("已工作 2m30s · Plan Mode");
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

describe("renderTwinnyThreadSummaryCard", () => {
  it("renders the compact thread summary layout", () => {
    const card = renderTwinnyThreadSummaryCard({
      name: "整理部署方案",
      creatorOpenId: "ou_guest",
      createdAt: 1,
      codexThreadId: "019e4af0-176c-7301-8d5c-2e642472826c",
      turnCount: 4,
      inputTokens: 32_200_000,
      outputTokens: 342_000,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 32_542_000,
      totalWorkDurationMs: 3_330_000,
      contextTokens: 0,
      contextWindow: 0
    });

    expect(card.config).toEqual({
      update_multi: true,
      style: {
        text_size: {
          normal_v2: {
            default: "normal",
            pc: "normal",
            mobile: "heading"
          }
        }
      }
    });
    expect(card.header).toMatchObject({
      title: { tag: "plain_text", content: "整理部署方案" },
      template: "blue",
      icon: { tag: "standard_icon", token: "table-group_outlined" }
    });
    expect(card.body).toMatchObject({
      elements: [
        {
          tag: "column_set",
          columns: [
            { elements: [expect.objectContaining({ content: "**输入**\n32.2 M", text_align: "center" })] },
            { elements: [expect.objectContaining({ content: "**输出**\n342 K", text_align: "center" })] },
            { elements: [expect.objectContaining({ content: "**时长**\n55m30s", text_align: "center" })] }
          ]
        },
        {
          tag: "div",
          text: {
            tag: "plain_text",
            content: "019e4af0-176c-7301-8d5c-2e642472826c",
            text_size: "notation",
            text_align: "left",
            text_color: "grey"
          }
        }
      ]
    });
  });
});
