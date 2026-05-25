<p align="center">
  <img src="./configs/banner.png" alt="Twinny banner" width="760" />
</p>

<h1 align="center">Twinny</h1>

<p align="center">
  <strong>把飞书/Lark 会话变成本地 Codex 工作区。</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/twinny"><img alt="npm" src="https://img.shields.io/npm/v/twinny.svg" /></a>
  <a href="./README.md">English</a>
</p>

Twinny 是一个本地 Feishu/Lark-to-Codex 桥接工具。它通过应用事件长连接接收 Lark 消息，把每个会话映射到 `TWINNY_HOME` 下的本地工作区，以 profile 维度使用独立的 `CODEX_HOME` 运行 Codex app-server thread，并把 Codex 结果发回 Lark。

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

installer 会：

1. 检测 Codex binary 和默认 Codex 模型设置。
2. 在浏览器中创建或选择飞书机器人应用，或接受手动配置的 App ID 和 App Secret。
3. 授权 owner 账号并保存 owner `open_id`。
4. 创建 `TWINNY_HOME`（默认 `~/.twinny`），包括 `config.toml`、`auth.json`、runtime 文件、SQLite 数据库和 workspaces。
5. 把 Lark app secret 存入 macOS Keychain。
6. 安装 macOS LaunchAgent，并可立即启动 Twinny。

常用 daemon 命令：

```sh
npx twinny@latest doctor
npx twinny@latest status
npx twinny@latest logs
npx twinny@latest start
npx twinny@latest stop
npx twinny@latest restart
npx twinny@latest uninstall
```

如果不使用默认 home，给任意命令加上 `TWINNY_HOME=/path/to/home`。

## 飞书/Lark 应用配置

installer 可以在浏览器中创建或选择飞书应用。如果你手动配置应用，请在飞书/Lark 开发者后台申请这些 API 权限：

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
| `new_session` | 从群菜单创建新的任务话题/会话。 |
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
| `/activate <owner_at\|owner\|all_at\|all> [profile]` | 激活群聊，设置响应范围，并可选绑定 profile。 |
| `/deactivate` | 停用当前群聊并清空待处理任务。 |
| `/pair {guest_ou_id} <profile>` | 授权非 owner 的 P2P 用户，并绑定到某个 profile。 |
| `/reload [profile]` | 修改配置后重载所有 Codex profiles，或只重载指定 profile。 |

响应模式：

- `owner_at`：只响应 owner 且提及 bot 的消息。
- `owner`：响应 owner 的所有消息。
- `all_at`：响应任意群成员且提及 bot 的消息。
- `all`：响应任意群成员的所有消息。

## 推荐实践

为项目或团队创建一个专用飞书/Lark 群。由 owner 用尽量小的可用权限激活群聊，然后为每个开发任务创建一个独立话题：

```text
/activate all_at guest
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
- 除非群成员范围非常可控，否则优先使用 `owner_at`、`owner` 或 `all_at`，不要直接使用 `all`。

Twinny 启动 Codex turn 时使用 `approvalPolicy = "never"`，因此 Codex 配置本身就是主要安全边界。

## 进阶配置

Twinny home 默认是 `~/.twinny`。home 中包含：

| 路径 | 作用 |
| --- | --- |
| `config.toml` | 主运行配置。 |
| `auth.json` | Lark app id、brand、owner open id 和 owner display name。 |
| `runtime/home-random` | 每个 home 的身份标识，用于 LaunchAgent 和 Keychain 名称。 |
| `runtime/lark-assets.json` | 已上传到 Lark 的 logo 和 banner 图片 key 缓存。 |
| `sqlite/twinny.db` | 会话、thread、队列和用量状态。 |
| `workspaces/` | 从 Lark 会话映射出来的本地工作区。 |
| `~/Library/Logs/twinny/` | LaunchAgent 和 Lark SDK 日志。 |

示例 `config.toml`：

```toml
[codex]
binary = "codex"

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

每个 home 都有独立的 config、auth 元数据、SQLite 状态、workspaces、runtime lock、Keychain account 和 LaunchAgent label。建议每个实例使用独立的 Feishu/Lark bot app，避免重复接收事件。
