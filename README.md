<p align="center">
  <img src="./configs/banner.png" alt="Twinny banner" width="760" />
</p>

<h1 align="center">Twinny</h1>

<p align="center">
  <strong>Turn Lark conversations into local Codex workspaces.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/twinny"><img alt="npm" src="https://img.shields.io/npm/v/twinny.svg" /></a>
  <a href="./README.zh-CN.md">简体中文</a>
</p>

Twinny is a local Feishu/Lark-to-Codex bridge. It receives Lark messages through the app event long connection, maps each conversation to a local workspace under `TWINNY_HOME`, runs Codex app-server threads with profile-specific `CODEX_HOME` directories, and sends Codex results back to Lark.

## Requirements

- macOS for the installer-managed LaunchAgent workflow.
- Node.js 22 or newer.
- Codex CLI 0.130.0 or newer in `PATH`, or set `CODEX_BINARY`.
- A Feishu/Lark bot app with the permissions and event subscriptions listed below.

## Installation

Run the interactive installer with `npx`:

```sh
npx twinny@latest install
```

The installer:

1. Detects your Codex binary and default Codex model settings.
2. Creates or selects a Feishu bot app, or accepts a manually configured App ID and App Secret.
3. Authorizes the owner account and stores the owner `open_id`.
4. Creates `TWINNY_HOME` (default: `~/.twinny`) with `config.toml`, `auth.json`, runtime files, SQLite storage, and workspaces.
5. Stores the Lark app secret in the macOS Keychain.
6. Installs a macOS LaunchAgent and can start Twinny immediately.

Useful daemon commands:

```sh
npx twinny@latest doctor
npx twinny@latest status
npx twinny@latest logs
npx twinny@latest start
npx twinny@latest stop
npx twinny@latest restart
npx twinny@latest uninstall
```

Use `TWINNY_HOME=/path/to/home` with any command when you are not using the default home.

## Feishu/Lark App Configuration

The installer can create or select a Feishu app in the browser. If you configure an app manually, grant these API permissions in the Feishu/Lark developer console:

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

Subscribe to these events/callbacks:

```text
im.message.receive_v1
im.message.recalled_v1
application.bot.menu_v6
card.action.trigger
```

Use the Feishu/Lark event long connection (WebSocket) mode. Twinny does not require a public HTTP callback URL for message events.

Optional bot shortcut menu entries can use these `event_key` values:

| Event key | Action |
| --- | --- |
| `help` | Send command help. |
| `status` | Show the current conversation and thread status. |
| `queue` | Toggle queue-next-message mode. |
| `new` | Open a new Codex thread in the current conversation. |
| `new_session` | Create a new task topic/session from a group menu. |
| `stop` | Stop the active turn and clear queued work. |

## Usage

Send normal messages to the bot to start or continue a Codex turn. In groups, the owner must activate the group before ordinary messages are routed to Codex.

### Conversation Commands

| Command | Usage |
| --- | --- |
| `/help` | Show available commands. |
| `/status` | Show conversation, Codex thread, model, token, and queue status. |
| `/new` | Stop the current task, clear queued messages, and open a new Codex thread. |
| `/stop [all\|<side_id>]` | Stop the active task and clear queued messages. Use `all` to stop side turns too, or a side id to stop one side turn. |
| `/next` | Interrupt the current task and start the next queued message. |
| `/steer` | Inject the next queued batch into the currently running Codex turn. |
| `/queue [message]` | Without a message, queue your next message. With a message, add that message to the next turn. |
| `/goal <objective>` | Set and run a Codex goal. A later `/goal` while the goal is active updates the objective. |
| `/plan [message]` | Enter plan mode. If a message is provided, process it in plan mode immediately. |
| `/exit` | Exit plan mode in the next queued control step. |
| `/side <message>` or `/btw <message>` | Start an ephemeral side conversation forked from the current Codex thread. |
| `/compact` | Compact the current Codex thread context in the next queued control step. |
| `/thread [message]` | Create a new Lark topic backed by a new Codex thread. If `message` is present, proxy it into that new topic. |
| `/fork [message]` | Fork the current Codex thread into a new Lark topic. If `message` is present, proxy it into that new topic. |
| `/model <model> <effort>` | Set the model and reasoning effort for future turns in the current thread. |
| `/logo` | Send the Twinny logo image. |
| `/twinny` or `/banner` | Send the Twinny banner card. |

### Group Administration

Only the configured owner can run these commands:

| Command | Usage |
| --- | --- |
| `/activate <owner_at\|owner\|all_at\|all> [profile]` | Activate a group, set who Twinny responds to, and optionally bind the group to a profile. |
| `/deactivate` | Disable Twinny in the current group and clear pending work. |
| `/pair {guest_ou_id} <profile>` | Authorize a non-owner P2P user and bind that user to a profile. |
| `/reload [profile]` | Reload all Codex profiles, or one named profile, after editing config. |

Response modes:

- `owner_at`: only owner messages that mention the bot.
- `owner`: all owner messages.
- `all_at`: messages from any group member that mention the bot.
- `all`: all messages from any group member.

## Recommended Practice

Create a dedicated Feishu/Lark group for a project or team. Let the owner activate the group with the least permissive useful mode, then create one topic per development task:

```text
/activate all_at guest
/thread fix the login callback race
/thread add the GitHub README
```

Use `/fork` when a task needs an alternative direction while preserving the original Codex thread history:

```text
/fork try the smaller refactor path
```

Keep each task's discussion inside its topic. This keeps Codex context, local workspace state, Lark discussion, and status cards separated by task.

## Security Notes

Twinny runs on the owner's local machine. Treat it as a local automation bridge, not as a hardened multi-tenant execution service.

The current default configuration is not fully ready for broad multi-user sharing. In particular, if you activate a group with the `host` profile and `all` response mode, every group member who can speak in that group can run work with the same Codex execution authority as the owner:

```text
/activate all host
```

Be careful with `all_at` as well: every group member who can mention the bot can submit work when the group is bound to a powerful profile.

Before using Twinny in shared groups:

- Prefer a dedicated `codex_home` for guest or team profiles instead of sharing the owner's `~/.codex`.
- Configure Codex sandbox, filesystem, network, and approval-related settings for that profile.
- Add workspace-level `.codex` overrides where your Codex setup supports project-local safety policy.
- Keep `permissions.p2p_default_profile = "none"` unless you intentionally want unpaired P2P users to get access.
- Use `owner_at`, `owner`, or `all_at` instead of `all` unless the group is tightly controlled.

Twinny starts Codex turns with `approvalPolicy = "never"`, so the Codex configuration is the main safety boundary.

## Advanced Configuration

Twinny home defaults to `~/.twinny`. The home contains:

| Path | Purpose |
| --- | --- |
| `config.toml` | Main runtime configuration. |
| `auth.json` | Lark app id, brand, owner open id, and owner display name. |
| `runtime/home-random` | Per-home identity used for LaunchAgent and Keychain names. |
| `runtime/lark-assets.json` | Cached uploaded Lark image keys for logo and banner. |
| `sqlite/twinny.db` | Conversation, thread, queue, and usage state. |
| `workspaces/` | Local workspaces mapped from Lark conversations. |
| `~/Library/Logs/twinny/` | LaunchAgent and Lark SDK logs. |

Example `config.toml`:

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

Relative `codex_home` paths are resolved under `TWINNY_HOME`. Each profile starts its own Codex app-server process with `CODEX_HOME` set to that profile's `codex_home`.

After editing profile config, run `/reload [profile]` from Lark or restart the daemon.

## Multiple Instances With `TWINNY_HOME`

Run multiple isolated Twinny instances by giving each instance its own home:

```sh
TWINNY_HOME="$HOME/.twinny-work" npx twinny@latest install
TWINNY_HOME="$HOME/.twinny-personal" npx twinny@latest install

TWINNY_HOME="$HOME/.twinny-work" npx twinny@latest status
TWINNY_HOME="$HOME/.twinny-personal" npx twinny@latest logs
```

Each home gets separate config, auth metadata, SQLite state, workspaces, runtime lock, Keychain account, and LaunchAgent label. Prefer a separate Feishu/Lark bot app per instance to avoid duplicate event delivery.
