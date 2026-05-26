# Twinny Agent Installation Guide

Twinny ([https://github.com/hachiwii/twinny](https://github.com/hachiwii/twinny)) is a bridge between Feishu and Codex.

This guide is for a coding agent that is installing Twinny for a user through the non-interactive installer.

## Goal

Install Twinny with:

```sh
npx twinny@latest install agent
```

Use the same npm tag for follow-up commands.

## Before Running

Run the installer in a background non-TTY shell process so stdout can be parsed as NDJSON.

Node.js 22 or newer with npm is required because the entrypoint is `npx`.

## Recommended Command

Use the default home unless the user requests another isolated instance:

```sh
npx twinny@latest install agent
```

For a custom home:

```sh
TWINNY_HOME="$HOME/.twinny-work" npx twinny@latest install agent
```

Default agent-mode choices are:

- `--env-mode default`: import all recommended launch environment variables.
- `--install-codex auto`: install Codex CLI with npm if it is missing.
- `--install-lark-cli auto`: install lark-cli after Twinny resources are uploaded if it is missing.
- `--start true`: start the daemon after installation.

Only override these when the user explicitly asks. For manual environment import, pass one `--env-key` per variable:

```sh
npx twinny@latest install agent --env-mode manual --env-key HTTP_PROXY --env-key HTTPS_PROXY
```

## Handling Installer Events

Read stdout line by line. Each line is a JSON object.

For `progress` events, keep waiting.

For `action_required` events, show the user the `verification_url` and `user_code`, then wait while the installer continues polling. These events are expected for:

- `bot_registration`: the user creates or authorizes the Feishu/Lark bot app in the browser.
- `owner_authorization`: the owner authorizes Twinny in the browser.

For `failed` events, report the `step`, `reason`, and `message`. Common recoveries:

- `codex_login`: ask the user to run `codex login`, then rerun the install command.
- `init`: the target `TWINNY_HOME` is not empty. Ask whether to use another home or clean the existing one.
- `bot_registration` or `owner_authorization`: ask the user to retry the browser flow and rerun the install command.

For `completed` events, record:

- `home`
- `app_id`
- `started`
- `guide_file_url`

Show `guide_file_url` to the user. It points to the local Twinny Feishu/Lark configuration guide generated for this bot app.

The installer stores secrets in Twinny home and should not print app secrets or access tokens. Do not echo secret files or environment values.

## After Install

Ask the user to open `guide_file_url` and finish the Feishu/Lark developer-console configuration shown there.

If the user cannot open the local page, read the file behind `guide_file_url` and summarize the required configuration steps. If you have browser-use, computer-use, or an equivalent browser automation capability, you can ask user to let you operate the browser.

Then verify:

```sh
npx twinny@latest status
npx twinny@latest doctor
```

If a custom home was used, pass the same `TWINNY_HOME` to every follow-up command.

## Updating Later

Update the installed Twinny runner with the same npm tag you want to install:

```sh
npx twinny@latest update
```

The update command restarts Twinny automatically when the current managed service uses the installed runner. To update without restart:

```sh
npx twinny@latest update --no-restart
```
