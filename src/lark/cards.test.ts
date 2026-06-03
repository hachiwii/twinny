import { describe, expect, it } from "vitest";
import {
  markdownElement,
  renderHiddenTwinnyStatusCard,
  renderTwinnyBannerCard,
  renderTwinnyAgentCard,
  renderTwinnyResumeHistoryCard,
  renderTwinnyResumeListCard,
  renderTwinnyStatusCard,
  renderTwinnyThreadSummaryCard,
  renderTwinnyWorkspaceSelectionMarkdown,
  SIDE_FOLLOWUP_INPUT_FORM_NAME,
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

  it("shows only the latest ten working process items and folds older progress", () => {
    const card = renderTwinnyAgentCard(createOptions({
      messages: Array.from({ length: 12 }, (_, index) => ({
        id: `m${index + 1}`,
        text: `step ${index + 1}`
      }))
    }));
    const bodyElements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
    const historyPanel = bodyElements.find((element) => element.tag === "collapsible_panel") as
      | { header?: unknown; elements?: Array<{ content?: string }> }
      | undefined;
    const visibleProgress = bodyElements
      .filter((element) => element.tag === "markdown" && typeof element.content === "string" && element.content.startsWith("- step "))
      .map((element) => String(element.content));

    expect(historyPanel).toMatchObject({
      header: {
        title: {
          tag: "plain_text",
          content: "更多历史进度"
        }
      }
    });
    expect(historyPanel?.elements?.[0]?.content).toBe("- step 1\n- step 2");
    expect(visibleProgress).toEqual(Array.from({ length: 10 }, (_, index) => `- step ${index + 3}`));
  });

  it("renders cancellation attribution above the interrupted-card status line", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "interrupted",
      messages: [{ id: "m1", text: "step 1" }],
      cancelledByOpenId: "ou_cancel"
    }));
    const bodyElements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
    const markdownElements = bodyElements.filter((element) => element.tag === "markdown");
    const cancelledIndex = markdownElements.findIndex((element) =>
      element.content === "被 <at id=ou_cancel></at> 取消"
    );
    const statusLineIndex = markdownElements.findIndex((element) =>
      typeof element.content === "string" && element.content.includes("With [Twinny]")
    );

    expect(cancelledIndex).toBeGreaterThanOrEqual(0);
    expect(statusLineIndex).toBeGreaterThan(cancelledIndex);
    expect(markdownElements[cancelledIndex]).toMatchObject({
      text_size: "notation"
    });
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

  it("does not render side follow-up input on working cards", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "working",
      hideQueueControls: true,
      sideFollowupInput: {
        sideSessionId: "side_1",
        inputId: "side_1:1",
        placeholder: "追加补充说明"
      }
    }));

    expect(findElementByTag(card, "input")).toBeUndefined();
    expect(findButton(card, "提交")).toBeUndefined();
  });

  it("renders finished side follow-up input before elapsed statusline", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "finished",
      messages: [{ id: "process_1", text: "done" }],
      sideFollowupInput: {
        sideSessionId: "side_1",
        inputId: "side_1:1",
        placeholder: "继续追问"
      },
      finalElements: [markdownElement("final")]
    }));
    const bodyElements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
    const inputIndex = bodyElements.findIndex((element) => element.tag === "input");
    const statusIndex = bodyElements.findIndex((element) =>
      JSON.stringify(element).includes("已工作")
    );

    expect(inputIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThan(inputIndex);
    expect(bodyElements[inputIndex]).toMatchObject({
      name: SIDE_FOLLOWUP_INPUT_FORM_NAME,
      placeholder: {
        tag: "plain_text",
        content: "继续追问"
      },
      behaviors: [
        expect.objectContaining({
          type: "callback",
          value: {
            twinny: true,
            action: "side_input_submit",
            stateKey: "p2p_ou_guest",
            sideSessionId: "side_1",
            inputId: "side_1:1"
          }
        })
      ]
    });
    expect(findButton(card, "提交")).toBeUndefined();
  });

  it("does not render side follow-up input on failed cards", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "failed",
      sideFollowupInput: {
        sideSessionId: "side_1",
        inputId: "side_1:1",
        placeholder: "继续追问"
      }
    }));

    expect(findElementByTag(card, "input")).toBeUndefined();
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
    const bodyElements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
    const errorIndex = bodyElements.findIndex(
      (element) => element.tag === "markdown" && element.content === "- [ERROR] Codex app-server reported an error"
    );
    const elapsedIndex = bodyElements.findIndex(
      (element) => JSON.stringify(element).includes("已工作 0s")
    );
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(elapsedIndex).toBeGreaterThan(errorIndex);
    expect(JSON.stringify(card)).not.toContain("暂无进度");
  });

  it("adds model, context, compact token usage, and Twinny link to the rich elapsed footer", () => {
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
    const footer = "<font color='grey'>已工作 2m30s · gpt-5.5 xhigh · 57% · ↑ 327 K (90% Cached) ↓ 1.21 K · With [Twinny](https://github.com/hachiwii/twinny)</font>";
    const footerElement = findElementsByTag(card, "markdown").find((element) => element.content === footer);

    expect(JSON.stringify(card)).toContain(footer);
    expect(footerElement).toMatchObject({
      tag: "markdown",
      content: footer,
      text_align: "left",
      text_size: "notation",
      margin: "4px 0px 4px 0px"
    });
    expect(footerElement).not.toHaveProperty("text");
    expect(footerElement).not.toHaveProperty("text_color");
    expect(JSON.stringify(card)).not.toContain("**↑**");
    expect(JSON.stringify(card)).not.toContain("**↓**");
  });

  it("adds plan mode to the elapsed footer when enabled", () => {
    const card = renderTwinnyAgentCard(createOptions({
      elapsedMs: 150_000,
      mode: "plan"
    }));

    expect(JSON.stringify(card)).toContain(
      "<font color='grey'>已工作 2m30s · Plan Mode · With [Twinny](https://github.com/hachiwii/twinny)</font>"
    );
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

  it("keeps SEND_TO_LARK examples inside markdown code in the process panel", () => {
    const card = renderTwinnyAgentCard(createOptions({
      status: "finished",
      messages: [{
        id: "m1",
        text: [
          "```",
          "SEND_TO_LARK: <img path=\"code.png\"></img>",
          "```",
          "SEND_TO_LARK: <img path=\"real.png\"></img>"
        ].join("\n")
      }],
      finalElements: []
    }));
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("code.png");
    expect(serialized).not.toContain("real.png");
  });
});

describe("renderTwinnyThreadSummaryCard", () => {
  it("renders the compact thread summary layout", () => {
    const card = renderTwinnyThreadSummaryCard({
      name: "整理部署方案",
      status: "idle",
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

  it("uses agent status colors for active thread summary cards", () => {
    const base = {
      name: "整理部署方案",
      creatorOpenId: "ou_guest",
      createdAt: 1,
      codexThreadId: "019e4af0-176c-7301-8d5c-2e642472826c",
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      totalWorkDurationMs: 0,
      contextTokens: 0,
      contextWindow: 0
    };

    expect(renderTwinnyThreadSummaryCard({ ...base, status: "idle" }).header).toMatchObject({ template: "blue" });
    expect(renderTwinnyThreadSummaryCard({ ...base, status: "working" }).header).toMatchObject({ template: "purple" });
    expect(renderTwinnyThreadSummaryCard({ ...base, status: "waiting" }).header).toMatchObject({ template: "yellow" });
  });
});

describe("renderTwinnyStatusCard", () => {
  it("renders status sections and hides system details when omitted", () => {
    const card = renderTwinnyStatusCard({
      topic: {
        id: "thread_status",
        name: "部署检查",
        mode: "plan",
        model: "GPT-5.5 (xhigh)",
        contextTokens: 23_200,
        contextWindow: 258_000,
        userMessageCount: 23,
        inputTokens: 123_000_000,
        cachedInputTokens: 98_400_000,
        outputTokens: 123_000,
        reasoningOutputTokens: 28_290,
        totalWorkDurationMs: 84_623_000
      },
      workspace: {
        id: "group_oc_group",
        type: "group",
        responseMode: "all_at",
        profile: "owner",
        path: "/tmp/twinny/workspaces/group_oc_group",
        topicCount: 39,
        userMessageCount: 239,
        inputTokens: 324_000_000,
        cachedInputTokens: 291_600_000,
        outputTokens: 1_230_000,
        reasoningOutputTokens: 147_600,
        totalWorkDurationMs: 84_623_000
      },
      user: {
        openId: "ou_owner",
        identity: "owner"
      }
    });

    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({
      schema: "2.0",
      config: {
        update_multi: true
      },
      body: {
        elements: [
          expect.objectContaining({ tag: "div", text: expect.objectContaining({ content: "话题" }) }),
          expect.objectContaining({ tag: "markdown" }),
          expect.objectContaining({ tag: "div", text: expect.objectContaining({ content: "工作区" }) }),
          expect.objectContaining({ tag: "markdown" }),
          expect.objectContaining({ tag: "div", text: expect.objectContaining({ content: "用户" }) }),
          expect.objectContaining({ tag: "markdown" })
        ]
      }
    });
    expect(serialized).toContain("GPT-5.5 (xhigh)");
    expect(serialized).toContain("23.2 K / 258 K (9%)");
    expect(serialized).toContain("123 M (80% Cached)");
    expect(serialized).toContain("123 K (23% Reasoning)");
    expect(serialized).toContain("群聊");
    expect(serialized).toContain("全部用户，at 消息");
    expect(serialized).toContain("| 身份 | owner |");
    expect(serialized).not.toContain("系统");
  });

  it("renders owner-only system details when provided", () => {
    const card = renderTwinnyStatusCard({
      topic: {
        mode: "default",
        model: "GPT-5.5 (xhigh)",
        contextTokens: 0,
        contextWindow: 0,
        userMessageCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalWorkDurationMs: 0
      },
      workspace: {
        id: "p2p_ou_owner",
        type: "p2p",
        responseMode: "all",
        profile: "owner",
        topicCount: 1,
        userMessageCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalWorkDurationMs: 0
      },
      user: {
        openId: "ou_owner",
        identity: "owner"
      },
      system: {
        twinnyHome: "/tmp/twinny",
        twinnyVersion: "v0.1.0",
        codexVersion: "codex-cli 0.132.0",
        larkAppId: "cli_xxx",
        fiveHourRemainingLimit: "77% (重置于 23:59)",
        sevenDayRemainingLimit: "55% (重置于 05/23 21:23)"
      }
    });

    const serialized = JSON.stringify(card);
    expect(serialized).toContain("系统");
    expect(serialized).toContain("Twinny Home");
    expect(serialized).toContain("/tmp/twinny");
    expect(serialized).toContain("Twinny 版本");
    expect(serialized).toContain("CodeX 版本");
    expect(serialized).toContain("cli_xxx");
    expect(serialized).toContain("剩余 5h 限额");
    expect(serialized).toContain("剩余 7d 限额");
    expect(serialized).toContain("77% (重置于 23:59)");
  });

  it("renders optional bottom status action buttons", () => {
    const card = renderTwinnyStatusCard({
      topic: {
        mode: "default",
        model: "GPT-5.5 (xhigh)",
        contextTokens: 0,
        contextWindow: 0,
        userMessageCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalWorkDurationMs: 0
      },
      workspace: {
        id: "group_oc_group",
        type: "group",
        responseMode: "all_at",
        topicCount: 0,
        userMessageCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalWorkDurationMs: 0
      },
      user: {
        openId: "ou_guest",
        identity: "guest"
      },
      hideAction: {
        twinny: true,
        action: "status_hide",
        stateKey: "group_oc_group",
        larkThreadId: "omt_thread"
      },
      refreshAction: {
        twinny: true,
        action: "status_refresh",
        stateKey: "group_oc_group",
        larkThreadId: "omt_thread"
      }
    });

    const refreshButton = findButton(card, "刷新");
    expect(refreshButton).toMatchObject({
      tag: "button",
      type: "default",
      behaviors: [
        {
          type: "callback",
          value: {
            twinny: true,
            action: "status_refresh",
            stateKey: "group_oc_group",
            larkThreadId: "omt_thread"
          }
        }
      ]
    });
    const button = findButton(card, "隐藏");
    expect(button).toMatchObject({
      tag: "button",
      type: "default",
      behaviors: [
        {
          type: "callback",
          value: {
            twinny: true,
            action: "status_hide",
            stateKey: "group_oc_group",
            larkThreadId: "omt_thread"
          }
        }
      ]
    });
    expect(((card.body as { elements: unknown[] }).elements.at(-1) as Record<string, unknown>).tag).toBe("column_set");
  });

  it("renders a hidden status card with only hidden body text", () => {
    const card = renderHiddenTwinnyStatusCard();

    expect(card.header).toBeUndefined();
    expect((card.body as { elements: Array<{ content?: string }> }).elements).toEqual([
      expect.objectContaining({ tag: "markdown", content: "状态卡片已隐藏" })
    ]);
  });
});

describe("renderTwinnyResumeListCard", () => {
  it("renders an untitled thread table with available paging actions", () => {
    const card = renderTwinnyResumeListCard({
      stateKey: "p2p_ou_guest",
      browserId: "browser_1",
      hasPreviousPage: false,
      hasNextPage: true,
      items: [
        {
          index: 1,
          threadId: "thread_external",
          name: "External thread",
          cwd: "/tmp/project"
        }
      ]
    });

    expect(card.header).toBeUndefined();
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Usage: `/resume [thread_id|序号] [session|local]`");
    expect(serialized).toContain("参数：`session` 使用原会话 `cwd`（默认）；`local` 使用当前会话 `cwd`。");
    expect(serialized).toContain("| 序号 | thread_id | name | cwd |");
    expect(serialized).toContain("thread_external");
    expect(findButton(card, "上一页")).toBeUndefined();
    expect(findButton(card, "下一页")).toMatchObject({
      behaviors: [{ value: { twinny: true, action: "resume_next", stateKey: "p2p_ou_guest", browserId: "browser_1" } }]
    });
  });

  it("omits paging actions when there are no available pages", () => {
    const card = renderTwinnyResumeListCard({
      stateKey: "p2p_ou_guest",
      browserId: "browser_1",
      hasPreviousPage: false,
      hasNextPage: false,
      items: []
    });

    expect(findButton(card, "上一页")).toBeUndefined();
    expect(findButton(card, "下一页")).toBeUndefined();
    expect(findElementByTag(card, "column_set")).toBeUndefined();
  });
});

describe("renderTwinnyResumeHistoryCard", () => {
  it("shows the latest ten messages and folds earlier history", () => {
    const card = renderTwinnyResumeHistoryCard({
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        text: `message ${index + 1}`
      }))
    });

    expect(card.header).toBeUndefined();
    const bodyElements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
    const historyPanel = bodyElements[0] as { header?: unknown; elements?: Array<{ content?: string }> };
    expect(historyPanel).toMatchObject({
      tag: "collapsible_panel",
      header: {
        title: {
          tag: "plain_text",
          content: "显示更多历史消息"
        }
      }
    });
    expect(historyPanel.elements?.[0]?.content).toContain("**User:** message 1");
    expect(historyPanel.elements?.[0]?.content).toContain("**Assistant:** message 2");
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("**User: **");
    expect(serialized).toContain("**User:** message 3");
    expect(serialized).toContain("**Assistant:** message 12");
  });
});

describe("renderTwinnyWorkspaceSelectionMarkdown", () => {
  it("renders workspace choices as the shared markdown table style", () => {
    const markdown = renderTwinnyWorkspaceSelectionMarkdown({
      command: "/workspace",
      target: "conversation",
      currentWorkspace: "/tmp/current",
      workspaces: ["/tmp/first", "/tmp/second"]
    });

    expect(markdown).toBe([
      "Usage: `/workspace [路径|序号]`",
      "说明：设置当前 `conversation` 的 `cwd`；不带参数时列出最近使用的 workspace。",
      "当前 `conversation` `cwd`：`/tmp/current`",
      "",
      "| 序号 | cwd |",
      "| --- | --- |",
      "| 1 | /tmp/first |",
      "| 2 | /tmp/second |"
    ].join("\n"));
  });
});

describe("renderTwinnyBannerCard", () => {
  it("renders the Twinny banner image when an image key is available", () => {
    const card = renderTwinnyBannerCard({ bannerImageKey: "img_banner", twinnyVersion: "20260523-d786ff949" });

    expect((card.body as { elements: unknown[] }).elements[0]).toMatchObject({
      tag: "img",
      img_key: "img_banner",
      scale_type: "fit_horizontal"
    });
    expect(JSON.stringify(card)).toContain("Twinny - Command Codex in Feishu");
    expect(JSON.stringify(card)).toContain("20260523-d786ff949 | [What's New](https://github.com/hachiwii/twinny/blob/master/CHANGELOG.md) | 🌟 Me");
    expect(cardSummary(card)).toBe("🐰 Twinny 20260523-d786ff949");
  });

  it("omits the banner image when no image key is available", () => {
    const card = renderTwinnyBannerCard();

    expect((card.body as { elements: Array<{ tag?: string }> }).elements[0]).toMatchObject({
      tag: "markdown"
    });
    expect(JSON.stringify(card)).not.toContain("\"tag\":\"img\"");
    expect(cardSummary(card)).toBe("🐰 Twinny dev");
  });
});
