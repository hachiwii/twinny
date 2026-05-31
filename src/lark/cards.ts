import type {
  CodexThreadMode,
  CodexThreadStatus,
  ConversationResponseMode,
  ConversationType,
  ProfileName,
  UserIdentity
} from "../types.js";
import { isPositionInTextRanges, markdownCodeRanges, markdownLines } from "../markdown.js";

export type LarkCardJson = Record<string, unknown>;
export type LarkCardElement = Record<string, unknown>;

export type TwinnyAgentCardStatus =
  | "working"
  | "finished"
  | "interrupted"
  | "paused"
  | "failed"
  | "waiting_input"
  | "waiting_plan"
  | "interrupted_input"
  | "interrupted_plan"
  | "accepted_plan";

export interface TwinnyAgentCardMessage {
  id: string;
  text: string;
  processOnly?: boolean;
}

export type TwinnyAgentCardActionValue =
  | TwinnyActiveAgentCardActionValue
  | TwinnySideFollowupCardActionValue;

export interface TwinnyActiveAgentCardActionValue {
  twinny: true;
  action: "stop" | "next" | "queue" | "request_input_submit" | "request_input_interrupt" | "plan_implement" | "plan_interrupt";
  stateKey: string;
  runId: number;
}

export interface TwinnySideFollowupCardActionValue {
  twinny: true;
  action: "side_input_submit";
  stateKey: string;
  sideSessionId: string;
}

export interface TwinnyStatusCardActionValue {
  twinny: true;
  action: "status_hide" | "status_refresh";
  stateKey: string;
  larkThreadId?: string;
}

export interface TwinnyResumeListActionValue {
  twinny: true;
  action: "resume_prev" | "resume_next";
  stateKey: string;
  browserId: string;
}

export interface TwinnyAgentCardInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export type TwinnyAgentCardWaiting =
  | {
      kind: "request_user_input";
      requestId: string;
      questions: TwinnyAgentCardInputQuestion[];
    }
  | {
      kind: "plan";
      planText: string;
    };

export interface RenderTwinnyAgentCardOptions {
  status: TwinnyAgentCardStatus;
  messages: TwinnyAgentCardMessage[];
  elapsedMs: number;
  runtimeStats?: TwinnyAgentCardRuntimeStats;
  queueDepth: number;
  queueNextMessage: boolean;
  stateKey: string;
  runId: number;
  iconImageKey?: string;
  mode?: CodexThreadMode;
  title?: string;
  subtitle?: string;
  hideQueueControls?: boolean;
  waiting?: TwinnyAgentCardWaiting;
  finalElements?: LarkCardElement[];
  mentionOpenIds?: string[];
  summaryText?: string;
  error?: string;
  sideFollowupInput?: {
    sideSessionId: string;
    placeholder: string;
  };
}

export interface TwinnyAgentCardRuntimeStats {
  model?: string;
  effort?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  contextTokens: number;
  contextWindow: number;
}

export const PLAN_IMPLEMENT_INSTRUCTION_FORM_NAME = "plan_implement_instruction";
export const SIDE_FOLLOWUP_INPUT_FORM_NAME = "side_followup_text";
const MAX_VISIBLE_WORKING_PROCESS_ITEMS = 10;

interface ParsedPlanMarkdown {
  rawText: string;
  title?: string;
  parts: ParsedPlanPart[];
}

interface ParsedPlanPart {
  title?: string;
  content: string;
}

export interface RenderTwinnyThreadSummaryCardOptions {
  name: string;
  status: CodexThreadStatus;
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

export interface RenderTwinnyStatusCardOptions {
  topic: {
    id?: string;
    name?: string;
    workspace?: string;
    mode: CodexThreadMode;
    model: string;
    contextTokens: number;
    contextWindow: number;
    userMessageCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalWorkDurationMs: number;
  };
  workspace: {
    id: string;
    type: ConversationType;
    responseMode: ConversationResponseMode;
    profile?: ProfileName;
    path?: string;
    topicCount: number;
    userMessageCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalWorkDurationMs: number;
  };
  user: {
    openId: string;
    identity: UserIdentity;
  };
  system?: {
    twinnyHome: string;
    twinnyVersion: string;
    codexVersion: string;
    larkAppId: string;
    fiveHourRemainingLimit: string;
    sevenDayRemainingLimit: string;
  };
  hideAction?: TwinnyStatusCardActionValue;
  refreshAction?: TwinnyStatusCardActionValue;
}

export interface TwinnyResumeListItem {
  index: number;
  threadId: string;
  name: string;
  cwd: string;
}

export interface RenderTwinnyResumeListCardOptions {
  stateKey: string;
  browserId: string;
  items: TwinnyResumeListItem[];
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  profile?: ProfileName;
  pageNumber?: number;
  pageSize?: number;
}

export interface TwinnyResumeHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export interface RenderTwinnyResumeHistoryCardOptions {
  messages: TwinnyResumeHistoryMessage[];
}

export interface TwinnyCronListItem {
  id: number;
  cronExpression: string;
  messageText: string;
  threadId: string;
  nextRunAt: string;
}

export interface RenderTwinnyCronListCardOptions {
  items: TwinnyCronListItem[];
  timezone: string;
}

export interface RenderTwinnyWorkspaceSelectionMarkdownOptions {
  command: "/workspace" | "/cd";
  target: "conversation" | "thread";
  currentWorkspace: string;
  workspaces: string[];
}

export interface RenderTwinnyBannerCardOptions {
  bannerImageKey?: string;
  twinnyVersion?: string;
}

const STATUS_HEADER: Record<TwinnyAgentCardStatus, { title: string; subtitle?: string; template: string }> = {
  working: { title: "工作中...", template: "purple" },
  finished: { title: "已完成", template: "green" },
  interrupted: { title: "已中断", template: "grey" },
  paused: { title: "工作中断", subtitle: "服务重启中，任务将在重启后自动恢复", template: "grey" },
  failed: { title: "发生错误", template: "red" },
  waiting_input: { title: "等待交互", template: "yellow" },
  waiting_plan: { title: "确认计划", template: "wathet" },
  interrupted_input: { title: "已跳过问题", template: "grey" },
  interrupted_plan: { title: "计划被拒绝", template: "grey" },
  accepted_plan: { title: "计划已确认", template: "turquoise" }
};
const RESUME_HISTORY_VISIBLE_MESSAGE_LIMIT = 10;

export function renderTwinnyAgentCard(options: RenderTwinnyAgentCardOptions): LarkCardJson {
  const header = STATUS_HEADER[options.status];
  const parsedPlan = options.waiting?.kind === "plan" ? parsePlanMarkdown(options.waiting.planText) : undefined;
  const title = cardHeaderTitle(options, header.title, parsedPlan);
  const subtitle = cardHeaderSubtitle(options, header, parsedPlan);
  const summaryContent = cardListSummaryContent(options, title);
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
      elements: bodyElements(options, parsedPlan)
    },
    header: {
      title: {
        tag: "plain_text",
        content: title
      },
      subtitle: {
        tag: "plain_text",
        content: subtitle
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

export function renderTwinnyStatusCard(options: RenderTwinnyStatusCardOptions): LarkCardJson {
  const elements: LarkCardElement[] = [
    ...statusSection("话题", "command_outlined", [
      ["ID", options.topic.id ?? "未创建"],
      ["名称", options.topic.name ?? "未创建"],
      ["Workspace", options.topic.workspace ?? "未创建"],
      ["模式", options.topic.mode],
      ["模型", options.topic.model],
      ["上下文窗口", formatStatusContext(options.topic.contextTokens, options.topic.contextWindow)],
      ["用户消息数", formatInteger(options.topic.userMessageCount)],
      ["输入 Tokens", formatStatusInputTokens(options.topic.inputTokens, options.topic.cachedInputTokens)],
      ["输出 Tokens", formatStatusOutputTokens(options.topic.outputTokens, options.topic.reasoningOutputTokens)],
      ["总工作时长", formatElapsed(options.topic.totalWorkDurationMs)]
    ]),
    ...statusSection("工作区", "home_outlined", [
      ["ID", options.workspace.id],
      ["类型", formatConversationType(options.workspace.type)],
      ["响应模式", formatResponseMode(options.workspace.responseMode)],
      ["配置", options.workspace.profile ?? "未创建"],
      ["路径", options.workspace.path ?? "未创建"],
      ["话题数", formatInteger(options.workspace.topicCount)],
      ["用户消息数", formatInteger(options.workspace.userMessageCount)],
      ["总输入 Token", formatStatusInputTokens(options.workspace.inputTokens, options.workspace.cachedInputTokens)],
      ["总输出 Token", formatStatusOutputTokens(options.workspace.outputTokens, options.workspace.reasoningOutputTokens)],
      ["总工作时长", formatElapsed(options.workspace.totalWorkDurationMs)]
    ]),
    ...statusSection("用户", "member_outlined", [
      ["ID", options.user.openId],
      ["身份", options.user.identity]
    ])
  ];

  if (options.system) {
    elements.push(...statusSection("系统", "setting_outlined", [
      ["Twinny Home", options.system.twinnyHome],
      ["Twinny 版本", options.system.twinnyVersion],
      ["CodeX 版本", options.system.codexVersion],
      ["Lark App ID", options.system.larkAppId],
      ["剩余 5h 限额", options.system.fiveHourRemainingLimit],
      ["剩余 7d 限额", options.system.sevenDayRemainingLimit]
    ]));
  }

  if (options.hideAction || options.refreshAction) {
    elements.push(statusActionButtonsElement({
      hideAction: options.hideAction,
      refreshAction: options.refreshAction
    }));
  }

  return {
    schema: "2.0",
    config: {
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
    },
    body: {
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      padding: "12px 12px 12px 12px",
      elements
    }
  };
}

export function renderTwinnyResumeListCard(options: RenderTwinnyResumeListCardOptions): LarkCardJson {
  const pageLine = options.pageNumber && options.pageSize
    ? `第 ${options.pageNumber} 页，每页 ${options.pageSize} 个。`
    : undefined;
  const content = selectionMarkdown([
    `Usage: ${inlineCode("/resume [thread_id|序号] [session|local]")}`,
    `说明：恢复本机 Codex 会话；不带参数时列出可恢复的 ${inlineCode("thread")}。`,
    `参数：${inlineCode("session")} 使用原会话 ${inlineCode("cwd")}（默认）；${inlineCode("local")} 使用当前会话 ${inlineCode("cwd")}。`,
    options.profile ? `当前 profile：${inlineCode(options.profile)}` : undefined,
    pageLine
  ], resumeListTable(options.items));
  const elements = [markdownElement(content)];
  const actionButtons = resumeListActionButtonsElement(options);
  if (actionButtons) {
    elements.push(actionButtons);
  }
  return {
    schema: "2.0",
    config: {
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
    },
    body: {
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      padding: "12px 12px 12px 12px",
      elements
    }
  };
}

export function renderTwinnyResumeHistoryCard(options: RenderTwinnyResumeHistoryCardOptions): LarkCardJson {
  const elements = resumeHistoryElements(options.messages);
  return {
    schema: "2.0",
    config: {
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
    },
    body: {
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      padding: "12px 12px 12px 12px",
      elements
    }
  };
}

export function renderTwinnyCronListCard(options: RenderTwinnyCronListCardOptions): LarkCardJson {
  const content = selectionMarkdown([
    `Usage: ${inlineCode("/cron")}`,
    `Usage: ${inlineCode("/cron <cron exp> <message>")}`,
    `Usage: ${inlineCode("/cron rm <id>")}`,
    `说明：定时向当前 conversation 的指定 thread 发送消息；触发时 message 可继续解析指令。时区：${inlineCode(options.timezone)}。`
  ], cronListTable(options.items));
  return renderMarkdownOnlyCard(content);
}

export function renderHiddenTwinnyStatusCard(): LarkCardJson {
  return {
    schema: "2.0",
    config: {
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
    },
    body: {
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      padding: "12px 12px 12px 12px",
      elements: [markdownElement("状态卡片已隐藏")]
    }
  };
}

export function renderTwinnyWorkspaceSelectionMarkdown(options: RenderTwinnyWorkspaceSelectionMarkdownOptions): string {
  return selectionMarkdown([
    `Usage: ${inlineCode(`${options.command} [路径|序号]`)}`,
    `说明：设置当前 ${inlineCode(options.target)} 的 ${inlineCode("cwd")}；不带参数时列出最近使用的 workspace。`,
    `当前 ${inlineCode(options.target)} ${inlineCode("cwd")}：${inlineCode(options.currentWorkspace)}`
  ], workspaceSelectionTable(options.workspaces));
}

export function renderTwinnyWorkspaceSelectionCard(options: RenderTwinnyWorkspaceSelectionMarkdownOptions): LarkCardJson {
  return renderMarkdownOnlyCard(renderTwinnyWorkspaceSelectionMarkdown(options));
}

export function renderTwinnyThreadSummaryCard(options: RenderTwinnyThreadSummaryCardOptions): LarkCardJson {
  return {
    schema: "2.0",
    config: {
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
    },
    body: {
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      padding: "12px 12px 12px 12px",
      elements: [
        {
          tag: "column_set",
          horizontal_spacing: "8px",
          horizontal_align: "left",
          columns: [
            threadMetricColumn("输入", formatCompactTokenCount(options.inputTokens)),
            threadMetricColumn("输出", formatCompactTokenCount(options.outputTokens)),
            threadMetricColumn("时长", formatElapsed(options.totalWorkDurationMs))
          ],
          margin: "0px 0px 0px 0px"
        },
        {
          tag: "div",
          text: {
            tag: "plain_text",
            content: options.codexThreadId,
            text_size: "notation",
            text_align: "left",
            text_color: "grey"
          },
          margin: "0px 0px 0px 0px"
        }
      ]
    },
    header: {
      title: {
        tag: "plain_text",
        content: compactCardTitle(options.name) || "新会话"
      },
      subtitle: {
        tag: "plain_text",
        content: ""
      },
      template: threadSummaryHeaderTemplate(options.status),
      icon: threadSummaryHeaderIcon(options.iconImageKey),
      padding: "12px 12px 12px 12px"
    }
  };
}

export function renderTwinnyBannerCard(options: RenderTwinnyBannerCardOptions = {}): LarkCardJson {
  const version = options.twinnyVersion ?? "dev";
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: `🐰 Twinny ${version}`
      },
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
      padding: "0px 0px 12px 0px",
      elements: [
        ...(options.bannerImageKey
          ? [
              {
                tag: "img",
                img_key: options.bannerImageKey,
                preview: true,
                transparent: false,
                scale_type: "fit_horizontal",
                margin: "0px 0px 0px 0px"
              }
            ]
          : []),
        {
          tag: "markdown",
          content: `### 🐰 Twinny - Command Codex in Feishu\n${version} | [What's New](https://github.com/hachiwii/twinny/blob/master/CHANGELOG.md) | 🌟 Me on [Github](https://github.com/hachiwii/twinny)`,
          text_align: "center",
          text_size: "normal_v2",
          margin: "0px 0px 0px 0px"
        }
      ]
    }
  };
}

function compactCardTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderMarkdownOnlyCard(content: string): LarkCardJson {
  return {
    schema: "2.0",
    config: {
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
    },
    body: {
      direction: "vertical",
      horizontal_spacing: "8px",
      vertical_spacing: "8px",
      horizontal_align: "left",
      vertical_align: "top",
      padding: "12px 12px 12px 12px",
      elements: [markdownElement(content)]
    }
  };
}

function threadSummaryHeaderTemplate(status: CodexThreadStatus): string {
  if (status === "working") {
    return STATUS_HEADER.working.template;
  }
  if (status === "waiting") {
    return STATUS_HEADER.waiting_input.template;
  }
  return "blue";
}

function threadMetricColumn(label: string, value: string): LarkCardElement {
  return {
    tag: "column",
    width: "weighted",
    elements: [
      markdownElement(`**${label}**\n${value}`, {
        text_align: "center"
      })
    ],
    vertical_align: "top",
    weight: 1
  };
}

function threadSummaryHeaderIcon(iconImageKey: string | undefined): Record<string, string> {
  return iconImageKey
    ? {
        tag: "custom_icon",
        img_key: iconImageKey
      }
    : {
        tag: "standard_icon",
        token: "table-group_outlined"
      };
}

function statusSection(title: string, iconToken: string, rows: Array<[string, string]>): LarkCardElement[] {
  return [
    {
      tag: "div",
      text: {
        tag: "plain_text",
        content: title,
        text_size: "heading",
        text_align: "left",
        text_color: "default"
      },
      icon: {
        tag: "standard_icon",
        token: iconToken,
        color: "grey"
      },
      margin: "0px 0px 0px 0px"
    },
    markdownElement(statusMarkdownTable(rows))
  ];
}

function statusMarkdownTable(rows: Array<[string, string]>): string {
  return [
    "| 字段 | 值 |",
    "| -------- | -------- |",
    ...rows.map(([field, value]) => `| ${escapeTableCell(field)} | ${escapeTableCell(value)} |`)
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function formatConversationType(type: ConversationType): string {
  switch (type) {
    case "p2p":
      return "单聊";
    case "group":
      return "群聊";
    case "topic_group":
      return "话题群";
  }
}

function formatResponseMode(mode: ConversationResponseMode): string {
  switch (mode) {
    case "all":
      return "全部用户，全部消息";
    case "all_at":
      return "全部用户，at 消息";
    case "owner":
      return "仅 owner，全部消息";
    case "owner_at":
      return "仅 owner，at 消息";
    case "none":
      return "未激活";
  }
}

function formatStatusContext(contextTokens: number, contextWindow: number): string {
  const context = Math.max(0, Math.trunc(contextTokens));
  const window = Math.max(0, Math.trunc(contextWindow));
  const percentage = window > 0 ? Math.min(100, Math.max(0, (context / window) * 100)) : 0;
  return `${formatCompactTokenCount(context)} / ${formatCompactTokenCount(window)} (${Math.round(percentage)}%)`;
}

function formatStatusInputTokens(inputTokens: number, cachedInputTokens: number): string {
  const input = Math.max(0, Math.trunc(inputTokens));
  const cacheRatio = formatCachedInputRatio(input, cachedInputTokens);
  return cacheRatio
    ? `${formatCompactTokenCount(input)} (${cacheRatio} Cached)`
    : formatCompactTokenCount(input);
}

function formatStatusOutputTokens(outputTokens: number, reasoningOutputTokens: number): string {
  const output = Math.max(0, Math.trunc(outputTokens));
  const reasoningRatio = formatReasoningOutputRatio(output, reasoningOutputTokens);
  return reasoningRatio
    ? `${formatCompactTokenCount(output)} (${reasoningRatio} Reasoning)`
    : formatCompactTokenCount(output);
}

function formatReasoningOutputRatio(outputTokens: number, reasoningOutputTokens: number): string | undefined {
  if (outputTokens <= 0) {
    return undefined;
  }
  const reasoning = Math.max(0, Math.trunc(reasoningOutputTokens));
  const percentage = Math.min(100, Math.max(0, (reasoning / outputTokens) * 100));
  return `${Math.round(percentage)}%`;
}

function formatInteger(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString("en-US");
}

export function markdownElement(content: string, extra: Record<string, unknown> = {}): LarkCardElement {
  return {
    tag: "markdown",
    content: normalizeIndentedCodeFenceBlocks(content),
    text_align: "left",
    text_size: "normal_v2",
    margin: "0px 0px 0px 0px",
    ...extra
  };
}

interface MarkdownFenceState {
  indent: string;
  marker: "`" | "~";
  markerLength: number;
}

function normalizeIndentedCodeFenceBlocks(markdown: string): string {
  if (!markdown.includes("```") && !markdown.includes("~~~")) {
    return markdown;
  }

  const lines = markdown.split("\n");
  const normalized: string[] = [];
  let fence: MarkdownFenceState | undefined;

  for (const line of lines) {
    if (!fence) {
      const opening = parseMarkdownFenceOpening(line);
      if (!opening) {
        normalized.push(line);
        continue;
      }
      fence = opening;
      normalized.push(stripMarkdownFenceIndent(line, opening.indent));
      continue;
    }

    normalized.push(stripMarkdownFenceIndent(line, fence.indent));
    if (isMarkdownFenceClosing(line, fence)) {
      fence = undefined;
    }
  }

  return normalized.join("\n");
}

function parseMarkdownFenceOpening(line: string): MarkdownFenceState | undefined {
  const match = trimTrailingCarriageReturn(line).match(/^([ \t]*)(`{3,}|~{3,})/);
  if (!match) {
    return undefined;
  }
  const fenceMarker = match[2]!;
  return {
    indent: match[1]!,
    marker: fenceMarker[0] as "`" | "~",
    markerLength: fenceMarker.length
  };
}

function stripMarkdownFenceIndent(line: string, indent: string): string {
  if (!indent) {
    return line;
  }
  return line.startsWith(indent) ? line.slice(indent.length) : line;
}

function isMarkdownFenceClosing(line: string, fence: MarkdownFenceState): boolean {
  const match = trimTrailingCarriageReturn(line).match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
  if (!match) {
    return false;
  }
  const fenceMarker = match[1]!;
  return fenceMarker[0] === fence.marker && fenceMarker.length >= fence.markerLength;
}

function trimTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
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

function bodyElements(options: RenderTwinnyAgentCardOptions, parsedPlan?: ParsedPlanMarkdown): LarkCardElement[] {
  if (options.status === "finished") {
    return [
      ...finishedMentionElements(options.mentionOpenIds),
      ...finishedProcessPanelElements(options.messages),
      ...(options.finalElements?.length ? options.finalElements : [markdownElement("")]),
      ...sideFollowupInputElements(options),
      elapsedElement(options.elapsedMs, options.runtimeStats, options.mode)
    ];
  }

  if (
    options.status === "waiting_input" ||
    options.status === "interrupted_input" ||
    options.status === "waiting_plan" ||
    options.status === "interrupted_plan" ||
    options.status === "accepted_plan"
  ) {
    const elements: LarkCardElement[] = [
      ...finishedMentionElements(options.mentionOpenIds),
      ...finishedProcessPanelElements(options.messages)
    ];
    if (options.waiting?.kind === "request_user_input") {
      if (options.status === "waiting_input") {
        elements.push(requestUserInputFormElement(options));
        return elements;
      }
      elements.push(...requestUserInputElements(options.waiting.questions, { includeControls: false }));
    } else if (options.waiting?.kind === "plan") {
      elements.push(...planElements(parsedPlan ?? parsePlanMarkdown(options.waiting.planText), options.status));
    }
    elements.push(elapsedElement(options.elapsedMs, options.runtimeStats, options.mode));
    if (options.status === "waiting_input") {
      elements.push(waitingButtonsElement(options, "提交", "primary_filled", "request_input_submit", "跳过", "danger_filled", "request_input_interrupt"));
    } else if (options.status === "waiting_plan") {
      elements.push(planImplementFormElement(options));
    }
    return elements;
  }

  const elements = workingProcessElements(workingMessagesWithError(options));
  if (options.status !== "failed") {
    elements.push(...sideFollowupInputElements(options));
  }
  elements.push(elapsedElement(options.elapsedMs, options.runtimeStats, options.mode));
  if (options.status === "working") {
    elements.push(buttonsElement(options));
    if (!options.hideQueueControls) {
      elements.push(queueModeHintElement(options));
    }
  }
  return elements;
}

function workingMessagesWithError(options: RenderTwinnyAgentCardOptions): TwinnyAgentCardMessage[] {
  if (options.status !== "failed" || !options.error) {
    return options.messages;
  }
  return [
    ...options.messages,
    {
      id: "error",
      text: `[ERROR] ${options.error}`,
      processOnly: true
    }
  ];
}

function finishedMentionElements(openIds: string[] | undefined): LarkCardElement[] {
  const mentions = uniqueNonEmpty(openIds).map((openId) => `<at id=${openId}></at>`);
  return mentions.length > 0 ? [markdownElement(mentions.join(" "))] : [];
}

function finishedProcessPanelElements(messages: TwinnyAgentCardMessage[]): LarkCardElement[] {
  const rendered = renderProcessItems(messages);
  return rendered.length > 0 ? [processPanel(rendered)] : [];
}

function workingProcessElements(messages: TwinnyAgentCardMessage[]): LarkCardElement[] {
  const rendered = renderProcessItems(messages);
  if (rendered.length === 0) {
    return [progressPlaceholderElement()];
  }
  const historyCount = Math.max(0, rendered.length - MAX_VISIBLE_WORKING_PROCESS_ITEMS);
  const historical = rendered.slice(0, historyCount);
  const visible = rendered.slice(historyCount);
  const elements: LarkCardElement[] = [];
  if (historical.length > 0) {
    elements.push(processPanel(historical, "更多历史进度"));
  }
  for (let index = 0; index < visible.length; index += 1) {
    if (index > 0) {
      elements.push({ tag: "hr", margin: "4px 0px 4px 0px" });
    }
    elements.push(markdownElement(`- ${visible[index]}`));
  }
  return elements;
}

function processPanel(renderedMessages: string[], title = "工作过程"): LarkCardElement {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: title
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
    elements: [markdownElement(renderedMessages.map((message) => `- ${message}`).join("\n"))]
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
  const queueButtonType = options.queueNextMessage ? "primary" : "default";
  const buttons: LarkCardElement[] = [
    buttonElement("打断", "danger_filled", {
      twinny: true,
      action: "next",
      stateKey: options.stateKey,
      runId: options.runId
    })
  ];
  if (!options.hideQueueControls) {
    buttons.push(
      buttonElement(options.queueNextMessage ? "关闭排队" : "开启排队", queueButtonType, {
        twinny: true,
        action: "queue",
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

function statusActionButtonsElement(options: {
  hideAction?: TwinnyStatusCardActionValue;
  refreshAction?: TwinnyStatusCardActionValue;
}): LarkCardElement {
  const buttons: LarkCardElement[] = [];
  if (options.refreshAction) {
    buttons.push(buttonElement("刷新", "default", options.refreshAction));
  }
  if (options.hideAction) {
    buttons.push(buttonElement("隐藏", "default", options.hideAction));
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

function resumeListActionButtonsElement(options: RenderTwinnyResumeListCardOptions): LarkCardElement | undefined {
  const buttons: LarkCardElement[] = [];
  if (options.hasPreviousPage) {
    buttons.push(buttonElement("上一页", "default", {
      twinny: true,
      action: "resume_prev",
      stateKey: options.stateKey,
      browserId: options.browserId
    }));
  }
  if (options.hasNextPage) {
    buttons.push(buttonElement("下一页", "default", {
      twinny: true,
      action: "resume_next",
      stateKey: options.stateKey,
      browserId: options.browserId
    }));
  }
  if (buttons.length === 0) {
    return undefined;
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
    margin: "8px 0px 0px 0px"
  };
}

function waitingButtonsElement(
  options: RenderTwinnyAgentCardOptions,
  primaryLabel: string,
  primaryType: string,
  primaryAction: TwinnyActiveAgentCardActionValue["action"],
  dangerLabel: string,
  dangerType: string,
  dangerAction: TwinnyActiveAgentCardActionValue["action"],
  buttonOptions: { primaryFormSubmit?: boolean; namePrefix?: string } = {}
): LarkCardElement {
  const buttons = [
    buttonElement(primaryLabel, primaryType, {
      twinny: true,
      action: primaryAction,
      stateKey: options.stateKey,
      runId: options.runId
    }, {
      formSubmit: buttonOptions.primaryFormSubmit,
      name: buttonOptions.namePrefix ? `${buttonOptions.namePrefix}_submit` : undefined
    }),
    buttonElement(dangerLabel, dangerType, {
      twinny: true,
      action: dangerAction,
      stateKey: options.stateKey,
      runId: options.runId
    }, {
      name: buttonOptions.namePrefix ? `${buttonOptions.namePrefix}_interrupt` : undefined
    })
  ];
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [{ ...button, width: "fill" }],
      direction: "horizontal",
      vertical_align: "top"
    })),
    margin: "0px 0px 0px 0px"
  };
}

function requestUserInputFormElement(options: RenderTwinnyAgentCardOptions): LarkCardElement {
  const questions = options.waiting?.kind === "request_user_input" ? options.waiting.questions : [];
  return {
    tag: "form",
    name: "request_user_input",
    elements: [
      ...requestUserInputElements(questions),
      formElapsedElement(options),
      waitingButtonsElement(options, "提交", "primary_filled", "request_input_submit", "跳过", "danger_filled", "request_input_interrupt", {
        primaryFormSubmit: true,
        namePrefix: "request_user_input"
      })
    ],
    margin: "0px 0px 0px 0px"
  };
}

function planImplementFormElement(options: RenderTwinnyAgentCardOptions): LarkCardElement {
  return {
    tag: "form",
    name: "plan_implement",
    elements: [
      planImplementInstructionInputElement(),
      waitingButtonsElement(options, "实现", "primary_filled", "plan_implement", "拒绝", "danger_filled", "plan_interrupt", {
        primaryFormSubmit: true,
        namePrefix: "plan_implement"
      })
    ],
    margin: "0px 0px 0px 0px"
  };
}

function formElapsedElement(options: RenderTwinnyAgentCardOptions): LarkCardElement {
  return {
    tag: "column_set",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [elapsedElement(options.elapsedMs, options.runtimeStats, options.mode)],
        direction: "vertical",
        vertical_align: "top"
      }
    ],
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

function buttonElement(
  label: string,
  type: string,
  value: TwinnyAgentCardActionValue | TwinnyStatusCardActionValue | TwinnyResumeListActionValue,
  options: { formSubmit?: boolean; name?: string } = {}
): LarkCardElement {
  const element: LarkCardElement = {
    tag: "button",
    text: {
      tag: "plain_text",
      content: label
    },
    type,
    width: "default",
    size: "medium"
  };
  if (options.name) {
    element.name = options.name;
  }
  if (options.formSubmit) {
    element.action_type = "form_submit";
    element.value = value;
    return element;
  }
  element.behaviors = [
    {
      type: "callback",
      value
    }
  ];
  return element;
}

function elapsedElement(
  elapsedMs: number,
  runtimeStats: TwinnyAgentCardRuntimeStats | undefined,
  mode?: CodexThreadMode
): LarkCardElement {
  return markdownElement(
    elapsedRichText(elapsedMs, runtimeStats, mode),
    {
      text_size: "notation",
      margin: "4px 0px 4px 0px"
    }
  );
}

function elapsedRichText(
  elapsedMs: number,
  runtimeStats: TwinnyAgentCardRuntimeStats | undefined,
  mode?: CodexThreadMode
): string {
  return `<font color='grey'>${escapeInlineRichText(elapsedText(elapsedMs, runtimeStats, mode))} · With [Twinny](https://github.com/hachiwii/twinny)</font>`;
}

function elapsedText(
  elapsedMs: number,
  runtimeStats: TwinnyAgentCardRuntimeStats | undefined,
  mode?: CodexThreadMode
): string {
  const parts = [`已工作 ${formatElapsed(elapsedMs)}`, ...runtimeStatParts(runtimeStats)];
  if (mode === "plan") {
    parts.push("Plan Mode");
  }
  return parts.join(" · ");
}

function requestUserInputElements(
  questions: TwinnyAgentCardInputQuestion[],
  options: { includeControls?: boolean } = {}
): LarkCardElement[] {
  const includeControls = options.includeControls ?? true;
  const elements: LarkCardElement[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!;
    if (index > 0) {
      elements.push({ tag: "hr", margin: "0px 0px 0px 0px" });
    }
    const title = `${index + 1}. ${question.header || question.question || question.id}`;
    elements.push(markdownElement(`##### ${title}`, { margin: "8px 0px 8px 0px" }));
    const body = question.question.trim();
    if (body && body !== question.header.trim()) {
      elements.push(markdownElement(body, { margin: "0px 0px 0px 0px" }));
    }
    for (const option of question.options ?? []) {
      elements.push(markdownElement(`- **${escapeMarkdown(option.label)}**: ${escapeMarkdown(option.description)}`, { margin: "0px 0px 0px 0px" }));
    }
    if (includeControls && (question.options?.length ?? 0) > 0) {
      elements.push(selectElement(question));
    }
    if (includeControls && (question.isOther || (question.options?.length ?? 0) === 0)) {
      elements.push(inputElement(question));
    }
  }
  return elements.length > 0 ? elements : [progressPlaceholderElement()];
}

function planElements(plan: ParsedPlanMarkdown, status: TwinnyAgentCardStatus): LarkCardElement[] {
  if (!plan.title) {
    return [markdownElement(plan.rawText || "暂无计划")];
  }

  const parts = plan.parts.length > 0 ? plan.parts : [{ content: "暂无计划" }];
  if (status === "waiting_plan") {
    const elements: LarkCardElement[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) {
        elements.push({ tag: "hr", margin: "0px 0px 0px 0px" });
      }
      elements.push(markdownElement(formatPlanPartMarkdown(parts[index]!)));
    }
    return elements;
  }

  const [firstPart, ...remainingParts] = parts;
  const elements: LarkCardElement[] = [markdownElement(formatPlanPartMarkdown(firstPart!))];
  if (remainingParts.length > 0) {
    elements.push(fullPlanPanel(remainingParts));
  }
  return elements;
}

function fullPlanPanel(parts: ParsedPlanPart[]): LarkCardElement {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: "查看完整计划"
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
    elements: parts.map((part) => markdownElement(formatPlanPartMarkdown(part)))
  };
}

function formatPlanPartMarkdown(part: ParsedPlanPart): string {
  const content = part.content.trim();
  if (!part.title) {
    return content || "暂无计划";
  }
  return content ? `#### ${part.title}\n${content}` : `#### ${part.title}`;
}

function parsePlanMarkdown(planText: string): ParsedPlanMarkdown {
  const rawText = planText.trim();
  const normalized = planText.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return { rawText, parts: [] };
  }

  const lines = normalized.split("\n");
  let cursor = 0;
  while (cursor < lines.length && lines[cursor]!.trim() === "") {
    cursor += 1;
  }

  const title = parseMarkdownHeading(lines[cursor] ?? "", 1);
  if (title !== undefined) {
    cursor += 1;
  }

  const parts: ParsedPlanPart[] = [];
  const preambleLines: string[] = [];
  let currentPart: { title: string; lines: string[] } | undefined;
  let inFence = false;

  const pushPreamble = () => {
    const content = preambleLines.join("\n").trim();
    if (content) {
      parts.push({ content });
    }
    preambleLines.length = 0;
  };

  const pushCurrentPart = () => {
    if (!currentPart) {
      return;
    }
    const content = currentPart.lines.join("\n").trim();
    parts.push({ title: currentPart.title, content });
    currentPart = undefined;
  };

  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!;
    if (!inFence) {
      const partTitle = parseMarkdownHeading(line, 2);
      if (partTitle !== undefined) {
        if (currentPart) {
          pushCurrentPart();
        } else {
          pushPreamble();
        }
        currentPart = { title: partTitle, lines: [] };
        continue;
      }
    }

    if (currentPart) {
      currentPart.lines.push(line);
    } else {
      preambleLines.push(line);
    }

    if (isMarkdownFenceBoundary(line)) {
      inFence = !inFence;
    }
  }

  pushCurrentPart();
  pushPreamble();

  const parsed: ParsedPlanMarkdown = { rawText, parts };
  if (title !== undefined) {
    parsed.title = title;
  }
  return parsed;
}

function parseMarkdownHeading(line: string, level: 1 | 2): string | undefined {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
  if (!match || match[1]!.length !== level) {
    return undefined;
  }
  const heading = match[2]!.replace(/\s+#+\s*$/, "").trim();
  return heading || undefined;
}

function isMarkdownFenceBoundary(line: string): boolean {
  return /^\s*(```+|~~~+)/.test(line);
}

function selectElement(question: TwinnyAgentCardInputQuestion): LarkCardElement {
  return {
    tag: "select_static",
    name: formSelectName(question.id),
    placeholder: {
      tag: "plain_text",
      content: "请选择"
    },
    options: (question.options ?? []).map((option) => ({
      text: {
        tag: "plain_text",
        content: option.label
      },
      value: option.label,
      icon: {
        tag: "standard_icon",
        token: "check_outlined"
      }
    })),
    type: "default",
    width: "fill",
    initial_index: 1,
    margin: "0px 0px 0px 0px"
  };
}

function inputElement(question: TwinnyAgentCardInputQuestion): LarkCardElement {
  return {
    tag: "input",
    name: formOtherName(question.id),
    placeholder: {
      tag: "plain_text",
      content: question.options?.length ? "输入其它答案，选项将被忽略" : "请输入"
    },
    default_value: "",
    width: "fill",
    ...(question.isSecret ? { input_type: "password" } : {}),
    margin: "0px 0px 0px 0px"
  };
}

function planImplementInstructionInputElement(): LarkCardElement {
  return {
    tag: "input",
    name: PLAN_IMPLEMENT_INSTRUCTION_FORM_NAME,
    placeholder: {
      tag: "plain_text",
      content: "补充提交指令（可选）"
    },
    default_value: "",
    width: "fill",
    margin: "0px 0px 0px 0px"
  };
}

function sideFollowupInputElements(options: RenderTwinnyAgentCardOptions): LarkCardElement[] {
  if (!options.sideFollowupInput) {
    return [];
  }
  return [
    {
      tag: "input",
      name: SIDE_FOLLOWUP_INPUT_FORM_NAME,
      placeholder: {
        tag: "plain_text",
        content: options.sideFollowupInput.placeholder
      },
      default_value: "",
      width: "fill",
      behaviors: [
        {
          type: "callback",
          value: {
            twinny: true,
            action: "side_input_submit",
            stateKey: options.stateKey,
            sideSessionId: options.sideFollowupInput.sideSessionId
          }
        }
      ],
      margin: "4px 0px 4px 0px"
    }
  ];
}

function cardHeaderTitle(
  options: RenderTwinnyAgentCardOptions,
  fallback: string,
  parsedPlan: ParsedPlanMarkdown | undefined
): string {
  if (isPlanCardStatus(options.status) && options.waiting?.kind === "plan") {
    return parsedPlan?.title ?? fallback;
  }
  if (options.title) {
    return options.title;
  }
  return fallback;
}

function cardHeaderSubtitle(
  options: RenderTwinnyAgentCardOptions,
  header: { title: string; subtitle?: string },
  parsedPlan: ParsedPlanMarkdown | undefined
): string {
  if (options.subtitle) {
    return options.subtitle;
  }
  if (options.status === "waiting_input" && options.waiting?.kind === "request_user_input") {
    const count = options.waiting.questions.length;
    return `${count} 个问题待回答`;
  }
  if (isPlanCardStatus(options.status) && options.waiting?.kind === "plan" && parsedPlan?.title) {
    return header.title;
  }
  return header.subtitle ?? "";
}

function cardListSummaryContent(options: RenderTwinnyAgentCardOptions, title: string): string | undefined {
  if (options.status === "finished") {
    return cardSummaryContent(options.summaryText ?? "");
  }
  if (options.status === "waiting_plan" && options.waiting?.kind === "plan") {
    return `[待确认计划] ${title}`;
  }
  if (options.status === "waiting_input" && options.waiting?.kind === "request_user_input") {
    const count = options.waiting.questions.length;
    return `[需要交互] ${count} 个问题待回答`;
  }
  return undefined;
}

function isPlanCardStatus(status: TwinnyAgentCardStatus): boolean {
  return status === "waiting_plan" || status === "interrupted_plan" || status === "accepted_plan";
}

function formSelectName(id: string): string {
  return `answer_${safeFormKey(id)}_select`;
}

function formOtherName(id: string): string {
  return `answer_${safeFormKey(id)}_other`;
}

function safeFormKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

function escapeMarkdown(value: string): string {
  return value.replace(/\*/g, "\\*").replace(/_/g, "\\_");
}

function escapeInlineRichText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function selectionMarkdown(lines: Array<string | undefined>, table: string): string {
  return [
    ...lines.filter((line): line is string => typeof line === "string" && line.length > 0),
    "",
    table
  ].join("\n");
}

function resumeListTable(items: TwinnyResumeListItem[]): string {
  if (items.length === 0) {
    return markdownTable(["序号", "thread_id", "name", "cwd"], [["-", "-", "-", "暂无可恢复的 Codex thread"]]);
  }
  return markdownTable(
    ["序号", "thread_id", "name", "cwd"],
    items.map((item) => [
      String(item.index),
      item.threadId,
      item.name || "未命名",
      item.cwd || "未知"
    ])
  );
}

function cronListTable(items: TwinnyCronListItem[]): string {
  if (items.length === 0) {
    return markdownTable(["id", "cron", "message", "thread_id", "next_run_at"], [["-", "-", "-", "-", "暂无 cron 配置"]]);
  }
  return markdownTable(
    ["id", "cron", "message", "thread_id", "next_run_at"],
    items.map((item) => [
      String(item.id),
      item.cronExpression,
      item.messageText,
      item.threadId,
      item.nextRunAt
    ])
  );
}

function workspaceSelectionTable(workspaces: string[]): string {
  if (workspaces.length === 0) {
    return markdownTable(["序号", "cwd"], [["-", "最近 30 天没有可选 cwd"]]);
  }
  return markdownTable(
    ["序号", "cwd"],
    workspaces.map((workspace, index) => [String(index + 1), workspace])
  );
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(tableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(tableCell).join(" | ")} |`)
  ].join("\n");
}

function resumeHistoryElements(messages: TwinnyResumeHistoryMessage[]): LarkCardElement[] {
  if (messages.length === 0) {
    return [markdownElement("暂无历史消息")];
  }
  const visibleStart = Math.max(0, messages.length - RESUME_HISTORY_VISIBLE_MESSAGE_LIMIT);
  const olderMessages = messages.slice(0, visibleStart);
  const visibleMessages = messages.slice(visibleStart);
  return [
    ...(olderMessages.length > 0 ? [resumeHistoryPanel(olderMessages)] : []),
    markdownElement(formatResumeHistoryMessages(visibleMessages))
  ];
}

function resumeHistoryPanel(messages: TwinnyResumeHistoryMessage[]): LarkCardElement {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: "显示更多历史消息"
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
    elements: [markdownElement(formatResumeHistoryMessages(messages))]
  };
}

function formatResumeHistoryMessages(messages: TwinnyResumeHistoryMessage[]): string {
  return messages
    .map((message) => `- **${message.role === "user" ? "User" : "Assistant"}:** ${escapeListItemMarkdown(message.text)}`)
    .join("\n");
}

function tableCell(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

function escapeListItemMarkdown(value: string): string {
  return escapeMarkdown(value)
    .replace(/\r?\n/g, "\n  ")
    .trim();
}

function renderProcessItems(messages: TwinnyAgentCardMessage[]): string[] {
  return messages
    .map((message) => sanitizeProcessText(message.text))
    .filter((message) => message.length > 0);
}

function sanitizeProcessText(text: string): string {
  const codeRanges = markdownCodeRanges(text);
  return markdownLines(text)
    .filter((line) => {
      const firstNonWhitespace = line.text.search(/\S/);
      return firstNonWhitespace === -1 ||
        !line.text.slice(firstNonWhitespace).startsWith("SEND_TO_LARK:") ||
        isPositionInTextRanges(line.start + firstNonWhitespace, codeRanges);
    })
    .map((line) => line.text)
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

function runtimeStatParts(stats: TwinnyAgentCardRuntimeStats | undefined): string[] {
  if (!stats) {
    return [];
  }
  const parts: string[] = [];
  const model = formatModelAndEffort(stats.model, stats.effort);
  if (model) {
    parts.push(model);
  }
  const context = formatContextPercentage(stats.contextTokens, stats.contextWindow);
  if (context) {
    parts.push(context);
  }
  const tokenUsage = formatCompactTokenUsage(stats);
  if (tokenUsage) {
    parts.push(tokenUsage);
  }
  return parts;
}

function formatModelAndEffort(model: string | undefined, effort: string | undefined): string | undefined {
  const parts = [model, effort].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function formatContextPercentage(contextTokens: number, contextWindow: number): string | undefined {
  const tokens = Math.max(0, Math.trunc(contextTokens));
  const window = Math.max(0, Math.trunc(contextWindow));
  if (window <= 0) {
    return undefined;
  }
  return `${Math.round(Math.min(100, (tokens / window) * 100))}%`;
}

function formatCompactTokenUsage(stats: TwinnyAgentCardRuntimeStats): string | undefined {
  const inputTokens = Math.max(0, Math.trunc(stats.inputTokens));
  const outputTokens = Math.max(0, Math.trunc(stats.outputTokens));
  if (inputTokens === 0 && outputTokens === 0) {
    return undefined;
  }
  const cachedRatio = formatCachedInputRatio(inputTokens, stats.cachedInputTokens);
  const input = cachedRatio
    ? `${formatCompactTokenCount(inputTokens)} (${cachedRatio} Cached)`
    : formatCompactTokenCount(inputTokens);
  return `↑ ${input} ↓ ${formatCompactTokenCount(outputTokens)}`;
}

function formatCachedInputRatio(inputTokens: number, cachedInputTokens: number): string | undefined {
  if (inputTokens <= 0) {
    return undefined;
  }
  const cached = Math.max(0, Math.trunc(cachedInputTokens));
  const percentage = Math.min(100, Math.max(0, (cached / inputTokens) * 100));
  return `${Math.round(percentage)}%`;
}

function formatCompactTokenCount(value: number): string {
  const units = ["", "K", "M", "B"];
  let scaled = Math.max(0, Math.trunc(value));
  let unitIndex = 0;
  while (scaled >= 1000 && unitIndex < units.length - 1) {
    scaled /= 1000;
    unitIndex += 1;
  }
  let rounded = Number(scaled.toPrecision(3));
  if (rounded >= 1000 && unitIndex < units.length - 1) {
    unitIndex += 1;
    rounded = Number((Math.max(0, Math.trunc(value)) / 1000 ** unitIndex).toPrecision(3));
  }
  const formatted = String(rounded);
  return unitIndex === 0 ? formatted : `${formatted} ${units[unitIndex]}`;
}

function uniqueNonEmpty(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
