# Twinny

![Twinny banner](./configs/banner.png)

[![npm version](https://img.shields.io/npm/v/twinny.svg)](https://www.npmjs.com/package/twinny)

[English](./README.md)

## 环境要求

- macOS，用于 installer 管理的 LaunchAgent 工作流。
- Node.js 22 或更新版本。
- `PATH` 中有 Codex CLI 0.130.0 或更新版本，或者设置 `CODEX_BINARY`。
- 一个已配置下方权限和事件订阅的 Feishu/Lark 机器人应用。

## 安装

通过 `npx` 运行交互式 installer：

```sh
npx twinny@latest install
```

常用 daemon 命令：

```sh
npx twinny@latest doctor
npx twinny@latest status
npx twinny@latest start
npx twinny@latest stop
npx twinny@latest restart
npx twinny@latest uninstall
```

如果不使用默认 home，给任意命令加上 `TWINNY_HOME=/path/to/home`。

## 飞书/Lark 应用配置

你需要在飞书/Lark 开发者后台申请这些 API 权限：

```text
im:message.p2p_msg:readonly
im:message.group_msg
im:message:readonly
im:message:send_as_bot
im:message:update
im:message:recall
im:message.reactions:write_only
im:chat:read
im:chat:create
im:chat:update
im:resource
```

订阅这些事件/回调：

```text
im.message.receive_v1
im.message.recalled_v1
application.bot.menu_v6
card.action.trigger
```

事件订阅方式请选择飞书/Lark 事件长连接（WebSocket）。Twinny 不需要为消息事件暴露公网 HTTP callback URL。

可选机器人快捷菜单可以配置这些 `event_key`：

| Event key | 动作 |
| --- | --- |
| `help` | 发送指令帮助。 |
| `status` | 查看当前会话和 thread 状态。 |
| `queue` | 切换下一条消息排队模式。 |
| `new` | 在当前会话中新开 Codex thread。 |
| `stop` | 停止当前 turn 并清空队列。 |

## 用法

向机器人发送普通消息即可开始或继续 Codex turn。在群聊中，owner 必须先激活群聊，普通消息才会被路由给 Codex。

### 会话指令

| 指令 | 用法 |
| --- | --- |
| `/help` | 查看可用指令。 |
| `/status` | 查看会话、Codex thread、模型、token 和队列状态。 |
| `/new` | 停止当前任务、清空队列，并新开 Codex thread。 |
| `/stop [all\|<side_id>]` | 停止当前任务并清空队列。用 `all` 同时停止 side turn，或传 side id 停止指定 side turn。 |
| `/next` | 打断当前任务，并开始执行下一条排队消息。 |
| `/steer` | 把队列中的下一批消息注入当前正在运行的 Codex turn。 |
| `/queue [message]` | 不带 message 时让你的下一条消息排队；带 message 时把该消息加入下一轮。 |
| `/goal <objective>` | 设置并运行 Codex goal。goal 运行中再次发送 `/goal` 会更新目标。 |
| `/plan [message]` | 进入 plan mode。带 message 时直接用 plan mode 处理该消息。 |
| `/exit` | 在下一轮队列控制步骤中退出 plan mode。 |
| `/side <message>` 或 `/btw <message>` | 基于当前 Codex thread 发起临时 side conversation。 |
| `/compact` | 在下一轮队列控制步骤中压缩当前 Codex thread 上下文。 |
| `/thread [message]` | 创建一个新的 Lark 话题，并绑定新的 Codex thread。带 `message` 时会把消息代理到新话题内。 |
| `/fork [message]` | 从当前 Codex thread fork 出一个新的 Lark 话题。带 `message` 时会把消息代理到新话题内。 |
| `/model <model> <effort>` | 设置当前 thread 后续 turn 使用的模型和推理强度。 |
| `/logo` | 发送 Twinny logo 图片。 |
| `/twinny` 或 `/banner` | 发送 Twinny banner 卡片。 |

### 群管理指令

只有配置中的 owner 可以执行这些指令：

| 指令 | 用法 |
| --- | --- |
| `/activate <owner_at\|owner\|all_at\|all> [profile]` | 激活群聊，设置谁可以把消息路由给 Codex，刷新群名，并可选绑定 profile。 |
| `/deactivate` | 停用当前群聊并清空待处理任务。 |
| `/pair {guest_ou_id} <profile>` | 授权非 owner 的 P2P 用户，并绑定到某个 profile。 |
| `/reload [profile]` | 修改配置后重载所有 Codex profiles，或只重载指定 profile。 |

响应模式：

- `owner_at`：只响应 owner 且提及 bot 的消息。
- `owner`：响应 owner 的所有消息。
- `all_at`：响应任意群成员且提及 bot 的消息。
- `all`：响应任意群成员的所有消息。

## 推荐实践

为项目创建一个专用飞书/Lark 群。在该群的 workspace 中写一份 [AGENTS.md](http://AGENTS.md)。由 owner 用尽量小的可用权限激活群聊，然后为每个开发任务创建一个独立话题：

```text
/activate all host
/thread fix the login callback race
/thread add the GitHub README
```

当一个任务需要尝试替代方向，同时保留原 Codex thread 历史时，用 `/fork`：

```text
/fork try the smaller refactor path
```

把每个任务的讨论留在对应话题里。这样 Codex 上下文、本地 workspace 状态、Lark 讨论和状态卡都会按任务隔离。

## 安全说明

Twinny 运行在 owner 的本地机器上。请把它当作本地自动化桥接工具，而不是已经加固过的多人共享执行服务。

当前默认配置还没有 fully ready for 广泛多人共享。尤其是当你用 `host` profile 和 `all` 响应模式激活群聊时，群里所有能发言的成员都可以用 owner 的 Codex 执行权限来运行任务：

```text
/activate all host
```

也要谨慎使用 `all_at`：如果群聊绑定到高权限 profile，所有能提及 bot 的成员都可以提交任务。

在共享群聊中使用 Twinny 前：

- 优先给 guest 或团队 profile 配置独立的 `codex_home`，不要共享 owner 的 `~/.codex`。
- 为该 profile 配置 Codex sandbox、filesystem、network 和 approval 相关安全设置。
- 如果你的 Codex 设置支持项目级安全策略，在 workspace 的 `.codex` 中加入 override。
- 除非你明确希望未配对 P2P 用户获得访问权限，否则保持 `permissions.p2p_default_profile = "none"`。
- 除非群成员范围非常可控，否则优先使用 `owner_at` 或 `owner`，不要直接使用 `all` 或 `all_at`。

## 进阶配置

Twinny 从 `TWINNY_HOME` 读取 `config.toml`。

支持的字段：

| 字段 | 含义和取值 |
| --- | --- |
| `[codex].binary` | Codex CLI 可执行文件路径或命令名。默认是 `codex`。如果 LaunchAgent 不能通过 `PATH` 找到 Codex，建议使用绝对路径。 |
| `[lark.reaction].working` | Twinny 工作中给 Lark 消息添加的 emoji type。默认是 `Typing`。 |
| `[lark.reaction].queued` | 消息进入队列时添加的 Lark emoji type。默认是 `OneSecond`。 |
| `[lark.redaction].email` | 发往 Lark 的 payload 中邮箱地址的脱敏策略。`mask` 保留域名并遮蔽邮箱用户名，例如 `alice@example.com` 会变成 `a***e@example.com`；`whitespace` 插入空格，例如 `alice @ example.com`；`none` 发送明文邮箱。飞书可能会拦截包含明文邮箱或手机号的 bot message。默认是 `mask`。 |
| `[lark.redaction].chinese_phone_number` | 发往 Lark 的 payload 中中国手机号的脱敏策略。`mask` 保留前 3 位和后 4 位，例如 `138****5678`；`whitespace` 插入空格，例如 `138 1234 5678`；`none` 发送明文手机号。飞书可能会拦截包含明文邮箱或手机号的 bot message。默认是 `mask`。 |
| `[permissions].p2p_default_profile` | 未配对 P2P 用户第一次给 Twinny 发消息时使用的 profile。用 `none` 表示默认拒绝，也可以填已配置的 profile 名称来自动授权。默认是 `none`。 |
| `[profiles.<name>].codex_home` | 该 profile 使用的 `CODEX_HOME`。绝对路径会直接使用；相对路径会以 `TWINNY_HOME` 为基准解析。`host` 默认是 `~/.codex`；其他 profile 未设置时继承 `host`。 |
| `[profiles.<name>].default_model` | 该 profile 新 thread 的默认模型。`host` 默认是 `gpt-5.5`；其他 profile 未设置时继承 `host`。 |
| `[profiles.<name>].default_effort` | 该 profile 新 thread 的默认推理强度。常见取值是 `minimal`、`low`、`medium`、`high` 和 `xhigh`；`host` 默认是 `medium`；其他 profile 未设置时继承 `host`。 |
| `[telemetry].enabled` | 支持 telemetry 的构建使用的布尔关闭开关。设置为 `false` 会关闭事件采集。详见 [Telemetry](#telemetry)。 |

Telemetry 的数据范围和关闭方式见文末的 [Telemetry](#telemetry)。

示例 `config.toml`：

```toml
[codex]
binary = "/opt/homebrew/bin/codex"

[lark.reaction]
working = "Typing"
queued = "OneSecond"

[lark.redaction]
email = "mask"
chinese_phone_number = "mask"

[permissions]
p2p_default_profile = "none"

[profiles.host]
codex_home = "~/.codex"
default_model = "gpt-5.5"
default_effort = "medium"

[profiles.guest]
codex_home = "./profiles/guest-codex"
default_model = "gpt-5.5"
default_effort = "medium"
```

相对路径形式的 `codex_home` 会以 `TWINNY_HOME` 为基准解析。每个 profile 会启动独立的 Codex app-server 进程，并把 `CODEX_HOME` 设置为该 profile 的 `codex_home`。

修改 profile 配置后，可以在 Lark 中发送 `/reload [profile]`，或者重启 daemon。

## 通过 `TWINNY_HOME` 多实例部署

给每个实例指定独立 home，就可以运行多个隔离的 Twinny 实例：

```sh
TWINNY_HOME="$HOME/.twinny-work" npx twinny@latest install
TWINNY_HOME="$HOME/.twinny-personal" npx twinny@latest install

TWINNY_HOME="$HOME/.twinny-work" npx twinny@latest status
TWINNY_HOME="$HOME/.twinny-personal" npx twinny@latest logs
```

每个 home 都有独立的 config，并且需要一个独立的飞书机器人应用。

## Telemetry

启用 telemetry 的 Twinny 构建可能会发送匿名、best-effort 的使用和可靠性事件。这些数据用于监测产品质量、理解失败模式，并支持维护者围绕本地 agent 工作流的个人研究兴趣。

Twinny 不会收集或上传对话内容和凭据。这包括 Lark 消息正文、prompt、Codex 回答、飞书/Lark app secret 或 token、Codex 凭据或 session token、群名、发送者名称、原始 Lark 或 Codex ID、本地路径、环境变量值、API key 以及其他 secret。install、conversation、thread、turn、sender、message、Codex binary 等标识会先在本地加 salt 并 hash，再上传 hash 后的值。

Telemetry 可能包含：

- 安装和启动生命周期状态、启动耗时、LaunchAgent 配置状态；
- 运行时健康信号，例如 heartbeat、uptime、队列和 active turn 数量、内存使用量、Lark/Codex ready 状态；
- 消息路由元数据，例如 conversation type、message 或 action type、route kind、queue depth、resource count；
- turn 元数据，例如状态、类型、模型、reasoning effort、token 数、耗时、生成图片数量，以及失败时的 error code/category；
- 环境元数据，例如 Twinny、Codex、Node、OS version/platform/arch、Lark brand、profile count。

Telemetry 上报失败不会影响主流程，不应阻断安装、启动、消息处理或 Codex turn。

可以在 `config.toml` 中关闭 telemetry：

```toml
[telemetry]
enabled = false
```

也可以用环境变量关闭当前进程：

```sh
TWINNY_TELEMETRY_ENABLED=false npx twinny@latest start
```
