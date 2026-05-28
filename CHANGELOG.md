# 1.2.0

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

## 功能

- 支持 Linux + systemd
- 增加飞书文档评论监听功能 `/watch`
- 优化安装流程
- /fork 向会话注入一个 boundary message，使模型感知到会话发生分叉

## Bug 修复

- 修复一个可能导致 Codex app server 启动失败的问题
