export type LarkCardJson = Record<string, unknown>;
export type LarkCardElement = Record<string, unknown>;

export type TwinnyAgentCardStatus = "working" | "finished" | "interrupted" | "paused" | "failed";

export interface TwinnyAgentCardMessage {
  id: string;
  text: string;
}

export interface TwinnyAgentCardActionValue {
  twinny: true;
  action: "stop" | "next" | "queue";
  stateKey: string;
  runId: number;
}

export interface RenderTwinnyAgentCardOptions {
  status: TwinnyAgentCardStatus;
  messages: TwinnyAgentCardMessage[];
  elapsedMs: number;
  queueDepth: number;
  queueNextMessage: boolean;
  stateKey: string;
  runId: number;
  iconImageKey?: string;
  finalElements?: LarkCardElement[];
  summaryText?: string;
  error?: string;
}

export interface RenderTwinnyThreadSummaryCardOptions {
  creatorOpenId?: string;
  createdAt: number;
  codexThreadId: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  totalWorkDurationMs: number;
  contextTokens: number;
  contextWindow: number;
  iconImageKey?: string;
}

const STATUS_HEADER: Record<TwinnyAgentCardStatus, { title: string; template: string }> = {
  working: { title: "工作中...", template: "purple" },
  finished: { title: "已完成", template: "green" },
  interrupted: { title: "已中断", template: "grey" },
  paused: { title: "工作中断", template: "grey" },
  failed: { title: "发生错误", template: "red" }
};

export function renderTwinnyAgentCard(options: RenderTwinnyAgentCardOptions): LarkCardJson {
  const header = STATUS_HEADER[options.status];
  const summaryContent = options.status === "finished" ? cardSummaryContent(options.summaryText ?? "") : undefined;
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      ...(summaryContent === undefined
        ? {}
        : {
            summary: {
              content: summaryContent
            }
          }),
      style: {
        text_size: {
          normal_v2: {
            default: "normal",
            pc: "normal",
            mobile: "heading"
          }
        }
      }
    },
    body: {
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      padding: "12px 12px 12px 12px",
      elements: bodyElements(options)
    },
    header: {
      title: {
        tag: "plain_text",
        content: header.title
      },
      subtitle: {
        tag: "plain_text",
        content: ""
      },
      template: header.template,
      ...(options.iconImageKey
        ? {
            icon: {
              tag: "custom_icon",
              img_key: options.iconImageKey
            }
          }
        : {}),
      padding: "12px 12px 12px 12px"
    }
  };
}

export function renderTwinnyThreadSummaryCard(options: RenderTwinnyThreadSummaryCardOptions): LarkCardJson {
  const creator = options.creatorOpenId ? `<at id=${options.creatorOpenId}></at>` : "未知";
  const contextUsage = formatContextUsage(options.contextTokens, options.contextWindow);
  const rows = [
    ["Turn", String(options.turnCount)],
    ["Input Token", formatInteger(options.inputTokens)],
    ["Output Token", formatInteger(options.outputTokens)],
    ["Cache Input Token", formatInteger(options.cachedInputTokens)],
    ["Reasoning Token", formatInteger(options.reasoningOutputTokens)],
    ["Total Token", formatInteger(options.totalTokens)],
    ["总工作时间", formatElapsed(options.totalWorkDurationMs)],
    ["Context 用量", contextUsage]
  ];
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: "新会话"
      }
    },
    body: {
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      padding: "12px 12px 12px 12px",
      elements: [
        markdownElement(
          [
            `创建人：${creator}`,
            `创建时间：${formatTimestamp(options.createdAt)}`,
            `Codex Thread ID：${options.codexThreadId}`
          ].join("\n")
        ),
        markdownElement(markdownTable(["指标", "值"], rows))
      ]
    },
    header: {
      title: {
        tag: "plain_text",
        content: "新会话"
      },
      subtitle: {
        tag: "plain_text",
        content: ""
      },
      template: "blue",
      ...(options.iconImageKey
        ? {
            icon: {
              tag: "custom_icon",
              img_key: options.iconImageKey
            }
          }
        : {}),
      padding: "12px 12px 12px 12px"
    }
  };
}

export function markdownElement(content: string, extra: Record<string, unknown> = {}): LarkCardElement {
  return {
    tag: "markdown",
    content,
    text_align: "left",
    text_size: "normal_v2",
    margin: "0px 0px 0px 0px",
    ...extra
  };
}

export function imageElement(imageKey: string): LarkCardElement {
  return {
    tag: "img",
    img_key: imageKey,
    margin: "0px 0px 0px 0px"
  };
}

export function mediaElement(fileKey: string): LarkCardElement {
  return {
    tag: "media",
    file_key: fileKey,
    margin: "0px 0px 0px 0px"
  };
}

function bodyElements(options: RenderTwinnyAgentCardOptions): LarkCardElement[] {
  if (options.status === "finished") {
    return [
      processPanel(options.messages),
      ...(options.finalElements?.length ? options.finalElements : [markdownElement("")]),
      elapsedElement(options.elapsedMs, options.status)
    ];
  }

  const elements = workingProcessElements(options.messages);
  elements.push(elapsedElement(options.elapsedMs, options.status));
  if (options.status === "failed" && options.error) {
    elements.push(markdownElement(`- ${sanitizeProcessText(options.error)}`, { text_color: "red" }));
  }
  if (options.status === "working") {
    elements.push(buttonsElement(options));
    elements.push(queueModeHintElement(options));
  }
  return elements;
}

function workingProcessElements(messages: TwinnyAgentCardMessage[]): LarkCardElement[] {
  const rendered = renderProcessItems(messages);
  if (rendered.length === 0) {
    return [progressPlaceholderElement()];
  }
  const elements: LarkCardElement[] = [];
  for (let index = 0; index < rendered.length; index += 1) {
    if (index > 0) {
      elements.push({ tag: "hr", margin: "4px 0px 4px 0px" });
    }
    elements.push(markdownElement(`- ${rendered[index]}`));
  }
  return elements;
}

function processPanel(messages: TwinnyAgentCardMessage[]): LarkCardElement {
  const rendered = renderProcessItems(messages);
  const elements = rendered.length > 0
    ? [markdownElement(rendered.map((message) => `- ${message}`).join("\n"))]
    : [progressPlaceholderElement()];
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: "工作过程"
      },
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        color: "",
        size: "16px 16px"
      },
      icon_position: "right",
      icon_expanded_angle: -180
    },
    border: {
      color: "grey",
      corner_radius: "5px"
    },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements
  };
}

function progressPlaceholderElement(): LarkCardElement {
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content: "暂无进度",
      text_size: "notation",
      text_align: "center",
      text_color: "grey"
    },
    margin: "8px 0px 8px 0px"
  };
}

function buttonsElement(options: RenderTwinnyAgentCardOptions): LarkCardElement {
  const buttons: LarkCardElement[] = [
    buttonElement("打断", "danger_filled", {
      twinny: true,
      action: "next",
      stateKey: options.stateKey,
      runId: options.runId
    }),
    buttonElement(options.queueNextMessage ? "关闭排队" : "开启排队", "default", {
      twinny: true,
      action: "queue",
      stateKey: options.stateKey,
      runId: options.runId
    })
  ];
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "auto",
      elements: [button],
      direction: "horizontal",
      vertical_align: "top"
    })),
    margin: "0px 0px 0px 0px"
  };
}

function queueModeHintElement(options: RenderTwinnyAgentCardOptions): LarkCardElement {
  const hint = options.queueNextMessage
    ? "排队模式：新消息将等待当前任务完成后发送。"
    : options.queueDepth > 0
      ? "追加模式：新消息将和排队消息一起发送。"
      : "追加模式：新消息将被追加至当前任务。";
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content: hint,
      text_size: "notation",
      text_align: "left",
      text_color: "grey"
    },
    margin: "4px 0px 0px 0px"
  };
}

function buttonElement(label: string, type: string, value: TwinnyAgentCardActionValue): LarkCardElement {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: label
    },
    type,
    width: "default",
    size: "medium",
    behaviors: [
      {
        type: "callback",
        value
      }
    ]
  };
}

function elapsedElement(elapsedMs: number, status: TwinnyAgentCardStatus): LarkCardElement {
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content: elapsedText(elapsedMs, status),
      text_size: "notation",
      text_align: "left",
      text_color: "grey"
    },
    margin: "4px 0px 4px 0px"
  };
}

function elapsedText(elapsedMs: number, status: TwinnyAgentCardStatus): string {
  const elapsed = `已工作 ${formatElapsed(elapsedMs)}`;
  if (status === "paused") {
    return `${elapsed}，已暂停，服务重启后继续`;
  }
  return elapsed;
}

function renderProcessItems(messages: TwinnyAgentCardMessage[]): string[] {
  return messages
    .map((message) => sanitizeProcessText(message.text))
    .filter((message) => message.length > 0);
}

function sanitizeProcessText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("SEND_TO_LARK:"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function cardSummaryContent(text: string): string {
  return Array.from(sanitizeProcessText(text)).slice(0, 100).join("");
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

function formatInteger(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString("en-US");
}

function formatContextUsage(contextTokens: number, contextWindow: number): string {
  const tokens = Math.max(0, Math.trunc(contextTokens));
  const window = Math.max(0, Math.trunc(contextWindow));
  if (window <= 0) {
    return formatInteger(tokens);
  }
  const percentage = Math.min(100, (tokens / window) * 100);
  return `${formatInteger(tokens)} / ${formatInteger(window)} (${percentage.toFixed(1)}%)`;
}

function formatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "未知";
  }
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function markdownTable(headers: [string, string], rows: string[][]): string {
  return [
    `| ${headers.map(escapeMarkdownTableCell).join(" | ")} |`,
    "| --- | --- |",
    ...rows.map((row) => `| ${escapeMarkdownTableCell(row[0] ?? "")} | ${escapeMarkdownTableCell(row[1] ?? "")} |`)
  ].join("\n");
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
