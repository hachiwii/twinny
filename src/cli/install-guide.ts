import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as p from "@clack/prompts";
import { execa } from "execa";
import { resolveBundledLogoPath } from "../config/index.js";
import {
  LARK_BOT_MENU_EVENT,
  LARK_CARD_ACTION_TRIGGER_EVENT,
  LARK_MESSAGE_RECEIVE_EVENT,
  LARK_MESSAGE_RECALLED_EVENT,
  LARK_REQUIRED_SCOPES
} from "../lark/index.js";
import type { LarkBotMenuActionKey } from "../types.js";

export const installGuideRequiredEvents = [
  {
    event: LARK_MESSAGE_RECEIVE_EVENT,
    kind: "事件",
    description: "接收单聊和群聊消息"
  },
  {
    event: LARK_MESSAGE_RECALLED_EVENT,
    kind: "事件",
    description: "同步已撤回消息"
  },
  {
    event: LARK_BOT_MENU_EVENT,
    kind: "事件",
    description: "接收机器人自定义菜单点击"
  },
  {
    event: LARK_CARD_ACTION_TRIGGER_EVENT,
    kind: "回调",
    description: "接收卡片按钮和表单动作"
  }
] as const;

type InstallGuideBotMenuActionKey = Exclude<LarkBotMenuActionKey, "new_session">;

export const installGuideBotMenuActions = [
  {
    eventKey: "stop",
    label: "停止",
    description: "停止当前任务并清空排队内容"
  },
  {
    eventKey: "queue",
    label: "排队",
    description: "切换下一条消息排队模式"
  },
  {
    eventKey: "new",
    label: "新会话",
    description: "在当前对话中打开新的 Codex thread"
  },
  {
    eventKey: "status",
    label: "状态",
    description: "查看当前对话、thread、模型、token 和队列状态"
  },
  {
    eventKey: "help",
    label: "帮助",
    description: "发送 Twinny 命令帮助"
  }
] as const satisfies readonly {
  eventKey: InstallGuideBotMenuActionKey;
  label: string;
  description: string;
}[];

export interface InstallGuidePageResult {
  filePath: string;
  fileUrl: string;
}

export function buildInstallGuideScopeImportJson(scopes: readonly string[] = LARK_REQUIRED_SCOPES): string {
  return JSON.stringify({ scopes: { tenant: [...scopes] } }, null, 2);
}

export function buildInstallGuideHtml(
  appId: string,
  options: {
    logoDataUri?: string;
  } = {}
): string {
  const appPathId = encodeURIComponent(appId);
  const appIdLabel = escapeHtml(appId);
  const authUrl = `https://open.larkoffice.com/app/${appPathId}/auth`;
  const eventUrl = `https://open.larkoffice.com/app/${appPathId}/event`;
  const botUrl = `https://open.larkoffice.com/app/${appPathId}/bot`;
  const scopeImportJson = buildInstallGuideScopeImportJson();
  const logoMarkup = options.logoDataUri
    ? `<img class="logo-mark" src="${escapeHtmlAttribute(options.logoDataUri)}" alt="Twinny logo" />`
    : `<div class="logo-mark fallback-logo" aria-hidden="true">tw</div>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Twinny 飞书配置指引</title>
  <style>
    :root {
      color-scheme: light;
      --page: #fff8f4;
      --paper: #ffffff;
      --ink: #2d2521;
      --muted: #76645d;
      --line: #f0d6ca;
      --accent: #ee6841;
      --accent-strong: #d94d2c;
      --accent-soft: #fff0e8;
      --peach: #ffd8c7;
      --code: #2a211e;
      --code-text: #fff4ef;
      --blue: #28546f;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background:
        radial-gradient(circle at 16% 0%, rgba(255, 216, 199, 0.7), transparent 34rem),
        linear-gradient(180deg, var(--page), #fffdfb 44rem);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.65;
    }

    .page {
      width: min(960px, calc(100% - 32px));
      margin: 0 auto;
      padding: 36px 0 56px;
    }

    .masthead {
      display: grid;
      grid-template-columns: 104px minmax(0, 1fr);
      gap: 22px;
      align-items: center;
      padding: 24px 0 28px;
      border-bottom: 1px solid var(--line);
    }

    .logo-mark {
      width: 104px;
      height: 104px;
      border-radius: 8px;
      object-fit: cover;
      box-shadow: 0 18px 46px rgba(217, 77, 44, 0.18);
    }

    .fallback-logo {
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, var(--accent), #ffa37d);
      color: white;
      font-size: 2rem;
      font-weight: 800;
    }

    .eyebrow {
      margin: 0 0 4px;
      color: var(--accent-strong);
      font-size: 0.875rem;
      font-weight: 700;
      letter-spacing: 0;
    }

    h1 {
      margin: 0;
      color: var(--ink);
      font-size: 2.15rem;
      line-height: 1.15;
      letter-spacing: 0;
    }

    .lead {
      max-width: 680px;
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 1rem;
    }

    .app-id {
      display: inline-flex;
      margin-top: 14px;
      padding: 4px 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.68);
      color: var(--blue);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.85rem;
    }

    article {
      display: grid;
      gap: 26px;
      margin-top: 34px;
    }

    .step {
      padding: 0 0 26px 22px;
      border-left: 3px solid var(--peach);
      border-bottom: 1px solid var(--line);
    }

    .step:last-child {
      border-bottom: 0;
    }

    .step-header {
      display: flex;
      gap: 14px;
      align-items: baseline;
      margin-bottom: 8px;
    }

    .step-number {
      display: inline-grid;
      width: 28px;
      height: 28px;
      place-items: center;
      border-radius: 999px;
      background: var(--accent);
      color: #fff;
      font-size: 0.9rem;
      font-weight: 800;
      line-height: 1;
    }

    h2 {
      margin: 0;
      font-size: 1.45rem;
      line-height: 1.25;
      letter-spacing: 0;
    }

    p {
      margin: 10px 0;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 16px 0;
    }

    .button {
      display: inline-flex;
      min-height: 40px;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      padding: 9px 14px;
      background: var(--accent);
      color: white;
      font-weight: 700;
      text-decoration: none;
      box-shadow: 0 10px 22px rgba(217, 77, 44, 0.2);
    }

    .button.secondary {
      border: 1px solid var(--line);
      background: var(--paper);
      color: var(--accent-strong);
      box-shadow: none;
    }

    .button:hover {
      background: var(--accent-strong);
    }

    .button.secondary:hover {
      background: var(--accent-soft);
    }

    .code-toolbar {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-top: 14px;
      padding: 10px 12px;
      border-radius: 8px 8px 0 0;
      background: #3b2c27;
      color: var(--code-text);
      font-size: 0.875rem;
    }

    .copy-button {
      border: 1px solid rgba(255, 255, 255, 0.28);
      border-radius: 8px;
      padding: 6px 10px;
      background: transparent;
      color: var(--code-text);
      cursor: pointer;
      font: inherit;
      line-height: 1.2;
    }

    pre {
      margin: 0;
      overflow-x: auto;
      border-radius: 0 0 8px 8px;
      background: var(--code);
      color: var(--code-text);
    }

    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9rem;
    }

    pre code {
      display: block;
      padding: 16px;
      white-space: pre;
    }

    .table-group {
      margin-top: 18px;
    }

    h3 {
      margin: 0 0 8px;
      color: var(--ink);
      font-size: 1rem;
      line-height: 1.3;
      letter-spacing: 0;
    }

    .table-wrap {
      overflow-x: auto;
    }

    .config-table {
      width: 100%;
      min-width: 560px;
      border-collapse: collapse;
      table-layout: fixed;
    }

    .config-table th,
    .config-table td {
      padding: 12px 0;
      border-top: 1px solid var(--line);
      vertical-align: top;
      text-align: left;
    }

    .config-table th {
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 700;
    }

    .config-table th:first-child,
    .config-table td:first-child {
      width: 300px;
      padding-right: 18px;
    }

    .list {
      display: grid;
      gap: 10px;
      padding: 0;
      margin: 14px 0 0;
      list-style: none;
    }

    .list li {
      display: grid;
      grid-template-columns: minmax(160px, 230px) minmax(0, 1fr);
      gap: 12px;
      align-items: baseline;
      padding: 12px 0;
      border-top: 1px solid var(--line);
    }

    .tag {
      color: var(--accent-strong);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9rem;
      overflow-wrap: anywhere;
    }

    .kind {
      display: inline-flex;
      margin-right: 8px;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent-strong);
      font-size: 0.78rem;
      font-weight: 700;
    }

    .note {
      margin-top: 16px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.72);
      color: var(--muted);
    }

    @media (max-width: 680px) {
      .page {
        width: min(100% - 24px, 960px);
        padding-top: 22px;
      }

      .masthead {
        grid-template-columns: 72px minmax(0, 1fr);
        gap: 14px;
      }

      .logo-mark {
        width: 72px;
        height: 72px;
      }

      h1 {
        font-size: 1.55rem;
      }

      .step {
        padding-left: 14px;
      }

      .step-header {
        align-items: flex-start;
      }

      .list li {
        grid-template-columns: 1fr;
        gap: 4px;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="masthead">
      ${logoMarkup}
      <div>
        <p class="eyebrow">Twinny install wizard</p>
        <h1>飞书应用配置指引</h1>
        <p class="lead">请按照下面三步完成飞书开放平台配置。配置完成后，Twinny 才能在飞书里接收消息、回复结果、更新卡片，并响应快捷菜单。</p>
        <span class="app-id">App ID: ${appIdLabel}</span>
      </div>
    </header>

    <article>
      <section class="step">
        <div class="step-header">
          <span class="step-number">1</span>
          <h2>开通 API 权限</h2>
        </div>
        <p>进入「权限管理」，导入下面的 JSON 后保存并发布应用。</p>
        <div class="actions">
          <a class="button" href="${escapeHtmlAttribute(authUrl)}" target="_blank" rel="noreferrer">打开权限管理</a>
        </div>
        <div class="code-toolbar">
          <span>权限导入 JSON</span>
          <button class="copy-button" type="button" data-copy-target="scope-json">复制 JSON</button>
        </div>
        <pre><code id="scope-json">${escapeHtml(scopeImportJson)}</code></pre>
      </section>

      <section class="step">
        <div class="step-header">
          <span class="step-number">2</span>
          <h2>配置长连接事件</h2>
        </div>
        <p>进入「事件与回调」，将事件配置和回调配置都设置为长连接模式，然后添加下列事件和回调。</p>
        <div class="actions">
          <a class="button" href="${escapeHtmlAttribute(eventUrl)}" target="_blank" rel="noreferrer">打开事件与回调</a>
        </div>
        <div class="table-group">
          <h3>事件</h3>
          <div class="table-wrap">
            <table class="config-table">
              <thead>
                <tr>
                  <th>事件名称</th>
                  <th>用途</th>
                </tr>
              </thead>
              <tbody>
                ${installGuideRequiredEvents.filter((item) => item.kind === "事件").map((item) => `<tr><td><span class="tag">${escapeHtml(item.event)}</span></td><td>${escapeHtml(item.description)}</td></tr>`).join("\n                ")}
              </tbody>
            </table>
          </div>
        </div>
        <div class="table-group">
          <h3>回调</h3>
          <div class="table-wrap">
            <table class="config-table">
              <thead>
                <tr>
                  <th>回调名称</th>
                  <th>用途</th>
                </tr>
              </thead>
              <tbody>
                ${installGuideRequiredEvents.filter((item) => item.kind === "回调").map((item) => `<tr><td><span class="tag">${escapeHtml(item.event)}</span></td><td>${escapeHtml(item.description)}</td></tr>`).join("\n                ")}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="step">
        <div class="step-header">
          <span class="step-number">3</span>
          <h2>可选：配置快捷菜单</h2>
        </div>
        <p>进入「机器人能力」，配置机器人自定义菜单。菜单类型选择悬浮菜单，菜单响应动作设置为推送事件，事件 key 使用下面这些值。</p>
        <div class="actions">
          <a class="button secondary" href="${escapeHtmlAttribute(botUrl)}" target="_blank" rel="noreferrer">打开机器人能力</a>
        </div>
        <ul class="list">
          ${installGuideBotMenuActions.map((item) => `<li><span class="tag">${escapeHtml(item.eventKey)}</span><span><strong>${escapeHtml(item.label)}</strong>：${escapeHtml(item.description)}</span></li>`).join("\n          ")}
        </ul>
        <p class="note">配置后，机器人单聊界面会显示一组悬浮在输入框上的快捷命令。</p>
      </section>
    </article>
  </main>
  <script>
    for (const button of document.querySelectorAll("[data-copy-target]")) {
      button.addEventListener("click", async () => {
        const target = document.getElementById(button.dataset.copyTarget);
        if (!target) return;
        try {
          await navigator.clipboard.writeText(target.textContent || "");
          button.textContent = "已复制";
          setTimeout(() => {
            button.textContent = "复制 JSON";
          }, 1600);
        } catch {
          button.textContent = "手动复制";
        }
      });
    }
  </script>
</body>
</html>
`;
}

export async function writeInstallGuidePage(
  appId: string,
  options: {
    outputDir?: string;
    logoFilePath?: string;
  } = {}
): Promise<InstallGuidePageResult> {
  const outputDir = options.outputDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "twinny-install-guide-"));
  await fs.mkdir(outputDir, { recursive: true });
  const logoDataUri = await readImageDataUri(options.logoFilePath ?? resolveBundledLogoPath());
  const filePath = path.join(outputDir, "index.html");
  await fs.writeFile(filePath, buildInstallGuideHtml(appId, { logoDataUri }), "utf8");
  return {
    filePath,
    fileUrl: pathToFileURL(filePath).href
  };
}

export async function openInstallGuidePageBestEffort(appId: string): Promise<void> {
  let page: InstallGuidePageResult;
  try {
    page = await writeInstallGuidePage(appId);
  } catch (error) {
    p.log.warn(`配置指引页面写入失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const opened = await openLocalFileBestEffort(page.fileUrl);
  if (opened) {
    p.log.success("已打开飞书应用配置指引");
    return;
  }
  p.note(page.fileUrl, "无法自动打开配置指引，请手动打开");
}

async function readImageDataUri(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return `data:${imageMimeType(filePath)};base64,${data.toString("base64")}`;
}

function imageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  return "image/png";
}

async function openLocalFileBestEffort(fileUrl: string): Promise<boolean> {
  const command = process.platform === "darwin"
    ? { binary: "open", args: [fileUrl] }
    : process.platform === "win32"
      ? { binary: "cmd", args: ["/c", "start", "", fileUrl] }
      : { binary: "xdg-open", args: [fileUrl] };
  const result = await execa(command.binary, command.args, { reject: false });
  return result.exitCode === 0;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}
