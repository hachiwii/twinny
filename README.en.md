# Twinny

![Twinny banner](./configs/banner.png)

[![npm version](https://img.shields.io/npm/v/twinny.svg)](https://www.npmjs.com/package/twinny)

[简体中文](./README.md)

## Requirements

- macOS, Linux, WSL2, or Windows. The installer manages a macOS LaunchAgent, or a `--system-daemon` LaunchDaemon, on macOS, a systemd user service on Linux/WSL2 with systemd enabled, and a user-level scheduled task on Windows.
- Node.js 22.18.0 or newer. Twinny uses Node.js' built-in `node:sqlite` module and does not require an extra SQLite native addon.
- Codex CLI 0.134.0 or newer in `PATH`, or set `CODEX_BINARY`; the installer can install Codex automatically if it is missing.
- A Feishu/Lark bot app with the permissions and event subscriptions listed below.

## Installation

### Installation guide for Codex

Copy this prompt into Codex and let it run the agent installer:

```text
Read https://raw.githubusercontent.com/hachiwii/twinny/master/agent_installation_guide.md and follow instructions in it.
```

### Install Manually

Run the interactive installer with `npx`:

```sh
npx twinny@latest install
```

On macOS, Twinny installs as a LaunchAgent in the current GUI session by default. In SSH, CI, or another environment without a GUI LaunchAgent, the installer exits and asks you to use system daemon mode:

```sh
npx twinny@latest install --system-daemon
```

`--system-daemon` writes the plist to `/Library/LaunchDaemons` through `sudo` and sets `UserName` to the current user. Later `start`, `stop`, `restart`, and `status` commands keep using LaunchDaemon based on the service settings in `config.toml`.

Native Windows installs create a user-level Task Scheduler task that starts when the user logs in. If WSL2 does not have systemd enabled, the installer does not create a managed service; run Twinny in the foreground with `TWINNY_HOME=/path/to/home twinny run`, or enable WSL systemd and reinstall.

Useful service commands:

```sh
npx twinny@latest doctor
npx twinny@latest status
npx twinny@latest update
npx twinny@latest start
npx twinny@latest stop
npx twinny@latest restart
npx twinny@latest uninstall
```

Use `TWINNY_HOME=/path/to/home` with any command when you are not using the default home.

Secrets are stored outside `config.toml`. Non-macOS installs, including Windows, store the Lark `app_secret` in the `lark_app_secret` field in `TWINNY_HOME/auth.json`. macOS installs use the system Keychain by default; with `--disable-keychain`, or if the Keychain write fails, the installer stores the secret in `auth.json` instead. On startup, Twinny reads `auth.json` first, then falls back to `TWINNY_LARK_APP_SECRET` and the legacy secret store (macOS Keychain, `runtime/secrets.json` on other platforms).

## Feishu/Lark App Configuration

You need to grant these required API permissions in the Feishu/Lark developer console:

```text
im:message.p2p_msg:readonly
im:message.group_at_msg:readonly
im:message:readonly
im:message:send_as_bot
im:message:update
im:message:recall
im:message.reactions:write_only
im:chat:read
im:chat:create
im:chat:update
im:resource
contact:user.base:readonly
docs:document.comment:read
docs:document.comment:create
docs:document.comment:write_only
docs:document.media:download
wiki:node:read
```

Recommended: also grant `im:message.group_msg`. It lets `/activate owner` and `/activate all` receive non-@ group messages. If you only use `owner_at` or `all_at`, the required `im:message.group_at_msg:readonly` scope is enough. The install guide page pre-fills this recommended scope in its import JSON so you can switch group response modes later.

Subscribe to these events/callbacks:

```text
im.message.receive_v1
im.message.recalled_v1
drive.notice.comment_add_v1
application.bot.menu_v6
card.action.trigger
```

Use the Feishu/Lark event long connection (WebSocket) mode. Twinny does not require a public HTTP callback URL for message events.

Optional bot shortcut menu entries can use these `event_key` values:


| Event key | Action                                               |
| --------- | ---------------------------------------------------- |
| `help`    | Send command help.                                   |
| `status`  | Show the current conversation and thread status.     |
| `queue`   | Toggle queue-next-message mode.                      |
| `new`     | Open a new Codex thread in the current conversation. |
| `stop`    | Stop the active turn and clear queued work.          |


## Usage

Send normal messages to the bot to start or continue a Codex turn. In groups, the owner must activate the group before ordinary messages are routed to Codex.

### Conversation Commands


| Command                               | Usage                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/help`                               | Show available commands.                                                                                     |
| `/status`                             | Show conversation, Codex thread, model, token, and queue status.                                             |
| `/new`                                | Stop the current task, clear queued messages, and open a new Codex thread.                                   |
| `/stop [all\|<side_id>]`              | Stop the active task and clear queued messages. Use `all` to stop side turns too, or a side id to stop one side turn. |
| `/next`                               | Interrupt the current task and start the next queued message.                                                |
| `/steer`                              | Inject the next queued batch into the currently running Codex turn.                                          |
| `/queue [message]`                    | Without a message, queue your next message. With a message, add that message to the next turn.               |
| `/goal <objective>`                   | Set and run a Codex goal. A later `/goal` while the goal is active updates the objective.                    |
| `/plan [message]`                     | Enter plan mode. If a message is provided, process it in plan mode immediately.                              |
| `/exit`                               | Exit plan mode in the next queued control step.                                                              |
| `/side <message>` or `/btw <message>` | Start an ephemeral side conversation forked from the current Codex thread.                                   |
| `/compact`                            | Compact the current Codex thread context in the next queued control step.                                    |
| `/thread [message]`                   | Create a new Lark topic backed by a new Codex thread. If `message` is present, proxy it into that new topic. |
| `/fork [message]`                     | Fork the current Codex thread into a new Lark topic. If `message` is present, proxy it into that new topic.  |
| `/watch <lark_doc_url> [owner\|all\|none]` | Watch @bot comments on a Feishu/Lark document and route them to the current thread. Without arguments, list watchers for the current thread. `owner` responds only to the owner, `all` responds to everyone, and `none` disables the watcher. |
| `/model <model> <effort>`             | Set the model and reasoning effort for future turns in the current thread.                                   |
| `/logo`                               | Send the Twinny logo image.                                                                                  |
| `/twinny` or `/banner`                | Send the Twinny banner card.                                                                                 |


### Group Administration

Only the configured owner can run these commands:


| Command                         | Usage                                                                  |
| ------------------------------- | ---------------------------------------------------------------------- |
| `/activate <owner_at\|owner\|all_at\|all> [profile]` | Activate a group, set who can route messages to Codex, refresh the group name, and optionally bind the group to a profile. |
| `/deactivate`                   | Disable Twinny in the current group and clear pending work.            |
| `/pair {guest_ou_id} <profile>` | Authorize a non-owner P2P user and bind that user to a profile.        |
| `/reload [profile]`             | Reload all Codex profiles, or one named profile, after editing config. |


Response modes:

- `owner_at`: only owner messages that mention the bot.
- `owner`: all owner messages.
- `all_at`: messages from any group member that mention the bot.
- `all`: all messages from any group member.

## Recommended Practice

Create a dedicated Feishu/Lark group for a project. Write an [AGENTS.md](http://AGENTS.md) inside the group's workspace. Let the owner activate the group with the least permissive useful mode, then create one topic per development task:

```text
/activate all host
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
- Keep `permissions.group_default_profile = "none"` and `permissions.group_default_mode = "none"` unless you intentionally want new groups to auto-activate on the first matching message.
- Use `owner_at` or `owner` instead of `all` or `all_at` unless the group is tightly controlled.

## Advanced Configuration

Twinny reads `config.toml` from `TWINNY_HOME`.

Recognized fields:


| Field                                   | Meaning and values                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[codex].binary`                        | Codex CLI executable path or command name. Defaults to `codex`. Use an absolute path when the managed service cannot find Codex through `PATH`. On Windows this is usually `codex.cmd`.                                                                                                                                                                                                   |
| `[codex].masquerade_as_codex_cli`       | Sends Codex TUI clientInfo during Codex app-server initialization: `name = "codex-tui"`, `title = null`, and `version` parsed from the startup `codex --version` output. Defaults to `false`.                                                                                                                                                                                             |
| `[lark.reaction].working`               | Lark emoji type added while Twinny is working. Defaults to `JubilantRabbit`.                                                                                                                                                                                                                                                                                                             |
| `[lark.reaction].queued`                | Lark emoji type added to queued messages. Defaults to `OneSecond`.                                                                                                                                                                                                                                                                                                                       |
| `[lark.redaction].email`                | Redaction strategy for email addresses in outgoing Lark payloads. `mask` keeps the domain and masks the local part, for example `alice@example.com` becomes `a***e@example.com`; `whitespace` inserts spaces, for example `alice @ example.com`; `none` sends raw email addresses. Feishu may reject bot messages that contain raw email addresses or phone numbers. Defaults to `mask`. |
| `[lark.redaction].chinese_phone_number` | Redaction strategy for Chinese phone numbers in outgoing Lark payloads. `mask` keeps the first 3 and last 4 digits, for example `138****5678`; `whitespace` inserts spaces, for example `138 1234 5678`; `none` sends raw phone numbers. Feishu may reject bot messages that contain raw email addresses or phone numbers. Defaults to `mask`.                                           |
| `[permissions].p2p_default_profile`     | Profile used when an unpaired P2P user first messages Twinny. Use `none` to deny by default, or a configured profile name to auto-authorize. Defaults to `none`.                                                                                                                                                                                                                         |
| `[permissions].p2p_default_workspace`   | Default workspace template for new P2P conversations. Supports `{{twinny_home}}` and `{{conversation_key}}` variables. Defaults to `{{twinny_home}}/workspaces/{{conversation_key}}`. If the rendered directory already exists, Twinny reuses it; otherwise it creates it.                                                                                                               |
| `[permissions].group_default_profile`   | Profile used when a new group auto-activates. It only takes effect when both this field and `group_default_mode` are not `none`. Defaults to `none`.                                                                                                                                                                                                                                      |
| `[permissions].group_default_mode`      | Group response mode after auto-activation. Values are `owner_at`, `owner`, `all_at`, `all`, or `none`. When this and `group_default_profile` are both not `none`, the first new-group message matching the mode creates the workspace and activates the group. Defaults to `none`.                                                                                                       |
| `[permissions].group_default_workspace` | Default workspace template for new group conversations. Supports `{{twinny_home}}` and `{{conversation_key}}` variables. Defaults to `{{twinny_home}}/workspaces/{{conversation_key}}`. If the rendered directory already exists, Twinny reuses it; otherwise it creates it.                                                                                                             |
| `[service.launchd].mode`                | macOS launchd placement. `gui` uses the current `gui/<uid>` LaunchAgent by default; `daemon` uses a system LaunchDaemon. Usually written by `twinny install --system-daemon`.                                                                                                                                                                                                              |
| `[service.launchd].user_name`           | The plist `UserName` when `mode = "daemon"`. Usually written automatically by `twinny install --system-daemon` from the current user.                                                                                                                                                                                                                                                      |
| `[profiles.<name>].codex_home`          | `CODEX_HOME` for that profile. Absolute paths are used as-is; relative paths are resolved under `TWINNY_HOME`. `host` defaults to `~/.codex`; other profiles inherit `host` unless set.                                                                                                                                                                                                  |
| `[profiles.<name>].default_model`       | Default model for new threads in that profile. `host` defaults to `gpt-5.5`; other profiles inherit `host` unless set.                                                                                                                                                                                                                                                                   |
| `[profiles.<name>].default_effort`      | Default reasoning effort for new threads in that profile. Common values are `minimal`, `low`, `medium`, `high`, and `xhigh`; `host` defaults to `medium`; other profiles inherit `host` unless set.                                                                                                                                                                                      |
| `[telemetry].enabled`                   | Boolean opt-out for telemetry-capable builds. Set to `false` to disable event capture. See [Telemetry](#telemetry).                                                                                                                                                                                                                                                                      |


Telemetry data scope and opt-out settings are covered in [Telemetry](#telemetry).

Example `config.toml`:

```toml
[codex]
binary = "/opt/homebrew/bin/codex"
masquerade_as_codex_cli = false

[lark.reaction]
working = "JubilantRabbit"
queued = "OneSecond"

[lark.redaction]
email = "mask"
chinese_phone_number = "mask"

[permissions]
p2p_default_profile = "none"
p2p_default_workspace = "{{twinny_home}}/workspaces/{{conversation_key}}"
group_default_profile = "none"
group_default_mode = "none"
group_default_workspace = "{{twinny_home}}/workspaces/{{conversation_key}}"

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

Each home gets separate config and needs a separate Feishu bot app.

## Telemetry

Twinny builds with telemetry enabled may send anonymous, best-effort usage and reliability events. The data is used to monitor product quality, understand failure patterns, and support the maintainer's personal research interests around local-agent workflows.

Twinny does not collect or upload conversation content or credentials. This includes Lark message text, prompts, Codex answers, Feishu/Lark app secrets or tokens, Codex credentials or session tokens, chat names, sender names, raw Lark or Codex IDs, raw local paths, environment variable values, API keys, and other secrets. Identifiers such as install, conversation, thread, turn, sender, message, and Codex binary are salted and hashed locally before upload.

Telemetry may include:

- install and launch lifecycle status, startup duration, and managed service setup state;
- runtime health signals such as heartbeat, uptime, queue and active-turn counts, memory usage, and Lark/Codex readiness;
- message routing metadata such as conversation type, message or action type, route kind, queue depth, and resource counts;
- turn metadata such as status, type, model, reasoning effort, token counts, duration, generated image count, and error code/category when a turn fails;
- environment metadata such as Twinny, Codex, Node, OS version/platform/arch, Lark brand, and profile count.

Telemetry failures are ignored by the product path and should not affect install, launch, message handling, or Codex turns.

Disable telemetry in `config.toml`:

```toml
[telemetry]
enabled = false
```

Or disable it for a process with an environment variable:

```sh
TWINNY_TELEMETRY_ENABLED=false npx twinny@latest start
```

## License

MIT
