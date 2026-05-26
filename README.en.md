# Twinny

![Twinny banner](./configs/banner.png)

[![npm version](https://img.shields.io/npm/v/twinny.svg)](https://www.npmjs.com/package/twinny)

[简体中文](./README.md)

## Requirements

- macOS or Linux. The installer manages a macOS LaunchAgent on macOS and a systemd user service on Linux.
- Node.js 22 or newer.
- Codex CLI 0.130.0 or newer in `PATH`, or set `CODEX_BINARY`; the installer can install Codex automatically if it is missing.
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

Useful daemon commands:

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

Secrets are stored outside `config.toml`. macOS installs use the system Keychain. Linux installs use a `0600` JSON secret file under `TWINNY_HOME/runtime/secrets.json`, unless `TWINNY_LARK_APP_SECRET` is provided in the service environment.

## Feishu/Lark App Configuration

You need to grant these API permissions in the Feishu/Lark developer console:

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
docs:document.comment:read
docs:document.comment:create
docs:document.comment:write_only
```

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
- Use `owner_at` or `owner` instead of `all` or `all_at` unless the group is tightly controlled.

## Advanced Configuration

Twinny reads `config.toml` from `TWINNY_HOME`.

Recognized fields:


| Field                                   | Meaning and values                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[codex].binary`                        | Codex CLI executable path or command name. Defaults to `codex`. Use an absolute path when the LaunchAgent cannot find Codex through `PATH`.                                                                                                                                                                                                                                              |
| `[lark.reaction].working`               | Lark emoji type added while Twinny is working. Defaults to `JubilantRabbit`.                                                                                                                                                                                                                                                                                                             |
| `[lark.reaction].queued`                | Lark emoji type added to queued messages. Defaults to `OneSecond`.                                                                                                                                                                                                                                                                                                                       |
| `[lark.redaction].email`                | Redaction strategy for email addresses in outgoing Lark payloads. `mask` keeps the domain and masks the local part, for example `alice@example.com` becomes `a***e@example.com`; `whitespace` inserts spaces, for example `alice @ example.com`; `none` sends raw email addresses. Feishu may reject bot messages that contain raw email addresses or phone numbers. Defaults to `mask`. |
| `[lark.redaction].chinese_phone_number` | Redaction strategy for Chinese phone numbers in outgoing Lark payloads. `mask` keeps the first 3 and last 4 digits, for example `138****5678`; `whitespace` inserts spaces, for example `138 1234 5678`; `none` sends raw phone numbers. Feishu may reject bot messages that contain raw email addresses or phone numbers. Defaults to `mask`.                                           |
| `[permissions].p2p_default_profile`     | Profile used when an unpaired P2P user first messages Twinny. Use `none` to deny by default, or a configured profile name to auto-authorize. Defaults to `none`.                                                                                                                                                                                                                         |
| `[profiles.<name>].codex_home`          | `CODEX_HOME` for that profile. Absolute paths are used as-is; relative paths are resolved under `TWINNY_HOME`. `host` defaults to `~/.codex`; other profiles inherit `host` unless set.                                                                                                                                                                                                  |
| `[profiles.<name>].default_model`       | Default model for new threads in that profile. `host` defaults to `gpt-5.5`; other profiles inherit `host` unless set.                                                                                                                                                                                                                                                                   |
| `[profiles.<name>].default_effort`      | Default reasoning effort for new threads in that profile. Common values are `minimal`, `low`, `medium`, `high`, and `xhigh`; `host` defaults to `medium`; other profiles inherit `host` unless set.                                                                                                                                                                                      |
| `[telemetry].enabled`                   | Boolean opt-out for telemetry-capable builds. Set to `false` to disable event capture. See [Telemetry](#telemetry).                                                                                                                                                                                                                                                                      |


Telemetry data scope and opt-out settings are covered in [Telemetry](#telemetry).

Example `config.toml`:

```toml
[codex]
binary = "/opt/homebrew/bin/codex"

[lark.reaction]
working = "JubilantRabbit"
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

Each home gets separate config and needs a separate Feishu bot app.

## Telemetry

Twinny builds with telemetry enabled may send anonymous, best-effort usage and reliability events. The data is used to monitor product quality, understand failure patterns, and support the maintainer's personal research interests around local-agent workflows.

Twinny does not collect or upload conversation content or credentials. This includes Lark message text, prompts, Codex answers, Feishu/Lark app secrets or tokens, Codex credentials or session tokens, chat names, sender names, raw Lark or Codex IDs, raw local paths, environment variable values, API keys, and other secrets. Identifiers such as install, conversation, thread, turn, sender, message, and Codex binary are salted and hashed locally before upload.

Telemetry may include:

- install and launch lifecycle status, startup duration, and LaunchAgent setup state;
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
