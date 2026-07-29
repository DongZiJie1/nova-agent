# Quickstart

This page gets you from install to a useful first pi session.

## Install

Pi is distributed as an npm package:

```bash
npm install -g --ignore-scripts @dongzijie1/nova
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Pi does not require install scripts for normal npm installs.

### Uninstall

Use the package manager that installed pi. The curl installer uses npm globally, so curl and npm installs are removed with npm:

```bash
# curl installer or npm install -g
npm uninstall -g @dongzijie1/nova

# pnpm
pnpm remove -g @dongzijie1/nova

# Yarn
yarn global remove @dongzijie1/nova

# Bun
bun uninstall -g @dongzijie1/nova
```

Uninstalling pi leaves settings, credentials, sessions, and installed pi packages in `~/.nova/agent/`.

Then start pi in the project directory you want it to work on:

```bash
cd /path/to/project
nova
```

## Authenticate

Nova can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start nova and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching nova:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
nova
```

You can also run `/login` and select an API-key provider to store the key in `~/.nova/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once nova starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, nova gives the model four tools:

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. Nova runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give pi project instructions

Nova loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Nova loads:

- `~/.nova/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart nova, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
nova @README.md "Summarize this"
nova @src/app.ts @src/app.test.ts "Review these together"
```

Images or text can be pasted with Ctrl+V (Alt+V on Windows); images can also be dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
nova -c                  # Continue most recent session
nova -r                  # Browse previous sessions
nova --name "my task"    # Set session display name at startup
nova --session <path|id> # Open a specific session
```

Inside pi, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
nova -p "Summarize this codebase"
cat README.md | nova -p "Summarize this text"
nova -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Pi](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Pi Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
