# 1.5.2

发布时间：2026/06/11

## Bug 修复

- 修复完成卡片中模型输出空行被压缩的问题，避免独立小标题贴到上一行内容后面。
- 修复工作过程卡片对模型输出格式的处理，保留原始换行和缩进，并且不再解析或过滤 `SEND_TO_LARK` 示例文本。

# 1.5.1

发布时间：2026/06/10

## 新增功能

- 新增 owner-only `/restart` 和 `/upgrade [check] [stable|beta]` 指令，支持在飞书里检查新版本、调度托管服务重启或升级。
- 新增 Twinny 自动升级检查和 runner 替换 helper，支持下载目标版本、重启健康检查和失败回滚。
- `/watch` 文档监听模式扩展为 `owner_at`、`owner`、`all_at`、`all`，可分别控制是否只处理 owner、是否要求评论 @ bot。
- 工作过程卡片在被打断时会展示取消人，方便确认是谁停止了任务。
- `/workspace` 和 `/cd` 的帮助与同步行为调整，设置 conversation workspace 时会同步当前非主 thread。

## Bug 修复

- 修复工作过程和最终回复里的 Lark at 语法：prompt 改为 `<at id="{open_id}"></at>`，同时保留旧 `<at openid="...">` 和 `<mention_lark_user>` 兼容解析。
- 修复 Markdown 图片解析和发送：支持 final answer 与 side final 中的本地图片附件，远端或非法图片路径会降级为可读提示。
- 修复本地 Markdown 链接识别过宽的问题，只把绝对本地路径链接改写为代码，避免普通链接在飞书里消失。
- 修复 final answer 后 turn 可能不完成、final card 等待状态卡住、fallback completion 状态不一致的问题。
- 修复 side follow-up 卡片回调、重复输入、过期卡片和 stale card patch 可能导致工作过程卡片状态错误的问题。
- 修复文档评论监听队列里同一评论的连续回复批处理和 workspace command thread 同步问题。
- 收紧邮件地址脱敏匹配，减少误匹配。

# 1.5.0

发布时间：2026/06/03

## 新增功能

- 新增 reply-to 上下文注入：未绑定 Lark thread 的回复消息、未记录 Lark thread 的首条非 root 消息，会把被回复消息或 thread root 消息作为 `<reply_to>` 上下文传给 Codex。
- `/thread` 和 `/fork` 创建的新 thread 默认继承来源 thread 的 model、effort 和 workspace；`/model` 指令的 effort 参数改为可选，并新增 `/effort` 指令单独设置 reasoning effort。
- 新增 conversation greeting 配置：单聊和群聊可分别配置固定文案或 Codex turn greeting；自动激活事件或手动 `/activate`、`/pair` 创建 conversation 时可发送 greeting。

## Bug 修复

- 修复新 Lark thread 中直接执行 `/model`、`/effort` 等配置指令时，因为还没有 Codex thread 而报错的问题；现在会先创建 thread 再应用配置。
- 修复 `/model` 指令可能把后续普通文本误解析为 effort 的问题。
- 修复 greeting 自动激活检查，只有对应单聊或群聊 greeting 确实启用时才订阅和提示额外事件权限。

# 1.4.0

发布时间：2026/06/01

## 新增功能

- 新增 side turn 卡片追问输入框：运行中可追加补充说明，完成或被打断后可继续追问并在原 side thread 中开启新一轮。
- 新增 `/rewind <n>` / `/rollback <n>` 指令，用于回退当前 Codex thread 最近若干轮，并同步更新 thread token 用量。
- 新增 Twinny thread 搜索动态工具 `search_threads`，支持在当前 conversation 内搜索 Twinny 管理的 thread 并返回 Codex 搜索片段。
- 增强 `wait_for_threads` 动态工具：支持 `timeout_ms: 0` 查看当前状态和最新输出，并改为任一目标 thread idle 后即返回。
- 增强跨 thread 消息路由：`tell_thread` 支持 `queue`、`steer`、`interrupt` 模式，运行中的目标 thread 可被注入或打断后继续处理。
- 更新 `/watch` 文档监听管理：移除 `none` 模式，新增 `/watch rm <id|url>` 删除监听；空 `/watch` 会列出监听 id。
- 新增文档监听动态工具 `watch_lark_url`、`list_lark_url_watchers`、`rm_lark_url_watchers`。
- 增强指令解析：支持从左到右解析连续指令，`/queue`、`/steer`、`/thread`、`/fork` 和 `/cron` 的消息内容可在执行时继续解析指令。
- cron 消息支持通过新版指令解析器触发 `/goal` 等指令，便于配置周期性目标任务。
- `wait_for_threads` 动态工具返回结果新增 thread token usage 信息。
- Codex CLI 最低版本要求更新为 0.134.0。

## Bug 修复

- 修复 fork、side 或 resume 出来的 thread 首轮会继承并重复计算历史 token 用量的问题。
- 修复 stale Codex turn notification 可能影响当前 Lark 消息状态的问题。
- 修复群聊 `all` / `owner` 模式下，用户 at 其他人但没有 at bot 的消息仍会被处理的问题。
- 调整安装 wizard：检测到未安装 `lark-cli` 时只提示建议安装并跳过相关流程，不再自动安装。

# 1.3.1

发布时间：2026/05/29

## Bug 修复

- 修复 Codex 动态工具转发 thread 到主群聊时，飞书可能返回 `230001 invalid request parameter` 的问题；主群聊改为发送可打开话题的链接，话题内仍优先使用飞书转发接口并在失败时回退到链接。
- 修复 Codex CLI masquerade 模式下，版本探测失败时把 `不可用` 写入 `clientInfo.version`，导致新版 Codex 在构造 `user-agent` header 时出现 UTF-8 header 错误并断流的问题；现在会尽量读取可解析的 Codex 版本，读取失败时留空，并记录版本探测失败日志。

# 1.3.0

发布时间：2026/05/29

## 新增功能

- 支持 Windows 与 WSL 下的服务安装、更新和手动运行流程。
- 新增定时任务能力，可在会话或话题中配置 cron job 并自动触发 Codex。
- 新增动态 thread 工具，支持 Codex 查询、等待、转发 thread，发送消息到指定 thread，以及创建新会话群。
- 支持通过配置设置群聊默认激活状态，便于新群使用自定义激活策略。
- 支持按全局、会话和话题配置默认工作目录，并同步中英文文档说明。
- 新增 Codex CLI masquerade 配置，用于调整 Codex app server 上报的 client 信息。

# 1.2.0

发布时间：2026/05/29

## 新增功能

- 新增 `/workspace` / `/cd` 指令，用于设置会话或话题的工作路径。
- 新增 `/resume` 指令，用于把已有 Codex thread 恢复为 Twinny 话题。
- 新增 Twinny 动态工具，支持 Codex 查询、等待、转发 thread，以及创建新会话群。
- 新增 Lark 配置检查，启动、`doctor`、群聊激活和文档监听时会提示缺失权限或事件配置。
- 增强 `/status` 卡片，展示 workspace、系统限额，并支持刷新/隐藏。
- Codex thread 名称增加 `[twinny]` 前缀，便于区分 Twinny 管理的线程。

## Bug 修复

- 修复 `/fork` 分支会话缺少边界提示，可能误继续父 thread 旧任务的问题。
- 修复 `/reload` 可能卡住自身控制队列的问题。
- 修复 `/side` 临时会话污染持久化 thread 列表的问题。
- 修复本地 Markdown 文件链接在飞书中渲染成不可用链接的问题。
- 修复完成态 agent 卡片遇到飞书频控后可能不更新的问题。

# 1.1.0

发布时间：2026/05/27

## 新增功能

- 支持 Linux + systemd
- 增加飞书文档评论监听功能 `/watch`
- 优化安装流程
- /fork 向会话注入一个 boundary message，使模型感知到会话发生分叉

## Bug 修复

- 修复一个可能导致 Codex app server 启动失败的问题
