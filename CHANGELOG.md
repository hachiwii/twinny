# 1.3.0

发布时间：2026/05/29

## 新增功能

- 支持 Windows 与 WSL 下的服务安装、更新和手动运行流程。
- 新增定时任务能力，可在会话或话题中配置 cron job 并自动触发 Codex。
- 新增动态 thread 工具，支持 Codex 查询、等待、转发 thread，发送消息到指定 thread，以及创建新会话群。
- 支持通过配置设置群聊默认激活状态，便于新群使用自定义激活策略。
- 支持按全局、会话和话题配置默认工作目录，并同步中英文文档说明。
- 新增 Codex CLI masquerade 配置，用于调整 Codex app server 上报的 client 信息。

## Bug 修复

- 修复定时任务可能触发未激活会话的问题。

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
