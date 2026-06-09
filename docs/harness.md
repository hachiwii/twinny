# Harness 兼容层（Codex / Claude Code）

Twinny 通过 harness 兼容层同时支持两种 agent 后端：

- `codex`：OpenAI Codex CLI（`codex app-server`，默认）
- `claude`：Anthropic Claude Code CLI（`claude -p` stream-json 模式）

harness 是 **thread 级** 属性：每个 Codex/Claude thread 在创建时绑定一个 harness 并持久化到本地数据库。老库升级后所有既有 thread 自动归为 `codex`，行为与升级前完全一致。

## 配置

`config.toml` 中所有 harness 配置均为可选；不写任何 harness 配置时，行为与旧版本完全相同（全部走 Codex）。

```toml
[harness]
# 新 thread 的默认 harness：codex（默认）或 claude
default = "codex"

[harness.codex]
# 可选：覆盖 codex harness 的默认模型与 effort。
# 不设置时沿用 profiles.<name>.default_model / default_effort（旧行为）。
default_model = "gpt-5.5"
default_effort = "medium"

[harness.claude]
# Claude Code CLI 路径，默认 "claude"
binary = "claude"
# claude harness 的默认模型与 effort（内置默认：sonnet / high）
default_model = "sonnet"
default_effort = "high"

[profiles.guest]
codex_home = "~/.twinny/profiles/guest/codex"
# 可选：为该 profile 指定独立的 Claude Code 配置目录（CLAUDE_CONFIG_DIR），
# 用于隔离 guest 的 Claude 账号/设置。不设置时使用当前用户默认的 ~/.claude。
claude_config_dir = "~/.twinny/profiles/guest/claude"
```

effort 取值与 `/effort` 指令一致：`low | medium | high | xhigh`。

## /harness 指令

- `/harness`：显示当前 thread 的 harness 与用法。
- `/harness codex` / `/harness claude`（别名 `claude-code`、`cc`）：切换 harness。

切换语义：**新开一个目标 harness 的 thread**（等同于 `/new`），并把该 thread 的 model 与 effort 重置为目标 harness 的默认值。之所以必须新开 thread，是因为两个后端的会话格式互不兼容（Codex rollout vs Claude Code session JSONL），跨 harness 无法继承会话历史。

继承规则：

- `/new`：沿用当前 thread 的 harness。
- `/thread`、`/fork`、`/side`：继承来源 thread 的 harness（fork/side 在 Claude 上使用 `--fork-session` 实现）。
- 其他途径新建的 thread（激活、greeting、pair、自动恢复等）：使用 `harness.default`。

`/status` 卡片会在模型信息后标注 `（claude harness）`。

## Claude Code 的实现方式

| Codex 概念 | Claude Code 实现 |
|---|---|
| thread | Claude Code session（UUID 由 Twinny 生成，经 `--session-id` 固定，重启后可 `--resume`） |
| turn/start | 每个 turn 启动一次 `claude -p --input-format stream-json --output-format stream-json --verbose`，会话经 `--session-id`（新）或 `--resume`（续） |
| turn/steer（运行中追加/追问） | 向运行中的进程 stdin 写入新的 user message。注意语义差异：Claude Code 会先答完当前 prompt，再把追加内容作为同一会话的下一条 prompt 处理；Twinny 会等全部 prompt 出结果后才结束本 turn。失败时回退到原有的"排队到下一轮"逻辑 |
| turn/interrupt | SIGINT（5 秒后 SIGKILL），turn 以 `interrupted` 结束 |
| thread/fork（/fork、/side） | `--resume <源> --fork-session --session-id <新>`，惰性在首个 turn 执行 |
| thread/inject_items（side 边界标记） | 模拟实现：注入文本缓存后拼接进该 thread 下一个 prompt 的 `<context>` 块 |
| thread/compact/start（/compact） | 以 `/compact` 作为 prompt 发送，使用 Claude Code 内置 compact（尽力而为） |
| approvalPolicy "never" + dangerFullAccess | `--dangerously-skip-permissions`；plan 模式映射为 `--permission-mode plan`（只读） |
| commentary / final_answer | 中间 assistant 文本 → commentary（卡片"工作过程"）；result 事件文本 → final_answer（终态卡正文） |
| token usage | result/assistant 的 usage 累加成 thread 级累计值，映射到与 Codex 相同的 tokenUsage 结构（cache 读取计入 cachedInputTokens；Claude 不上报 reasoning tokens，恒为 0） |
| model / effort | `--model <model>`；effort 经 `--settings '{"effort":"..."}'` 传入（Claude Code 的 effort 设置） |

## Claude harness 不支持的 Codex 功能及理由

以下功能在 claude thread 上会返回明确的错误提示（不会静默失败），原因均为 Claude Code CLI 没有对应的编程接口：

| 功能 | 行为 | 理由 |
|---|---|---|
| `/goal` 目标任务 | 报错拒绝 | goal 状态机（`thread/goal/*` 协议、暂停/恢复、预算控制）是 Codex app-server 专有协议，Claude Code 无对应概念 |
| `/rewind` / `/rollback` | 报错拒绝 | Claude Code 无"删除会话最近 N 轮"的 headless 接口（交互式 rewind 无法从 CLI 调用） |
| `/resume` 浏览历史 thread | 列表仅展示 Codex rollout | `thread/list`、`thread/read`、`thread/search` 读取的是 Codex rollout 存储；Claude session 无等价检索接口 |
| Twinny 动态工具（`search_threads`、`wait_for_threads`、`tell_thread`、`add_cron`、`watch_lark_url` 等） | claude turn 中模型不可调用 | 这些工具通过 Codex app-server 的动态工具注册协议注入；Claude Code 需要走 MCP server 才能等价实现，留作后续工作 |
| `request_user_input`（模型主动提问卡片） | 不会出现 | 同上，是 Codex 动态工具协议的一部分；Claude Code headless 无模型主动提问机制 |
| `set_thread_name`（模型改名 thread） | no-op | 同上；Twinny 自身数据库中的 thread 名称不受影响 |
| 账号用量（/status 中的 Codex Account Usage） | 仍显示 Codex 账号 | Claude Code 无账号限额查询接口（`/usage` 仅交互式） |
| goal 读取（恢复路径） | 返回"无 goal" | 安全降级，保证 daemon 重启恢复流程不因 claude thread 中断 |

其余功能（普通对话、排队、打断、`/side` 临时会话与卡片追问、`/plan`、`/compact`、`/model`、`/effort`、`/thread`、`/fork`、话题、群聊、cron 消息、卡片渲染、token 统计）在两种 harness 下行为一致。

## 安全说明

- claude turn 默认以 `--dangerously-skip-permissions` 运行，权限语义与 Codex 侧 `approvalPolicy: "never"` + `dangerFullAccess` 一致——这是 Twinny 既有的信任模型，不是 claude harness 新增的放权。
- 多 profile 部署（guest 隔离）时，建议为非 host profile 配置 `claude_config_dir`，避免 guest 共用 host 的 Claude 账号与全局设置。
