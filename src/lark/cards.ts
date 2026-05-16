export type LarkCardJson = Record<string, unknown>;
export type LarkCardElement = Record<string, unknown>;

export type TwinnyAgentCardStatus = "working" | "finished" | "interrupted" | "paused" | "failed";

export interface TwinnyAgentCardMessage {
  id: string;
  text: string;
}

export interface TwinnyAgentCardActionValue {
  twinny: true;
  action: "stop" | "next";
  stateKey: string;
  runId: number;
}

export interface RenderTwinnyAgentCardOptions {
  status: TwinnyAgentCardStatus;
  messages: TwinnyAgentCardMessage[];
  elapsedMs: number;
  queueDepth: number;
  stateKey: string;
  runId: number;
  iconImageKey?: string;
  finalElements?: LarkCardElement[];
  summaryText?: string;
  error?: string;
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
    buttonElement("停止", "danger_filled", {
      twinny: true,
      action: "stop",
      stateKey: options.stateKey,
      runId: options.runId
    })
  ];
  if (options.queueDepth > 0) {
    buttons.push(
      buttonElement("打断并处理队列中消息", "default", {
        twinny: true,
        action: "next",
        stateKey: options.stateKey,
        runId: options.runId
      })
    );
  }
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
