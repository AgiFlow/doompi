---
name: doom-runner
description: 'Manage long-running commands started by bash: dev servers, watchers, builds, tails, and anything that prompts for input. Trigger when a command needs to outlive the current turn, when bash output was truncated, or when a background process needs to be inspected, followed, given input, or stopped.'
---

# doom-runner

`bash` supervises what it starts. A command that outlives the background
threshold keeps running instead of blocking the turn. Use the `doom-runner`
CLI to manage it without adding another model tool.

## Backgrounding

- A command still running after 60 seconds (`DOOM_RUNNER_BG_THRESHOLD_MS`) is
  moved to the background automatically. You get its unique ID and streaming
  log path.
- Pass `background: true` for commands you already know will not finish: dev
  servers, watchers, `tail -f`. Waiting out the threshold first wastes a turn.
- Pass `interactive: true` when the command will prompt for confirmation or
  input. It runs under a terminal and backgrounds immediately. Answer it with
  `doom-runner input <id> --text <text> --enter`, or use Runner Space.
- Pass `timeout` (seconds) when you want a command killed rather than
  supervised. A timeout above the threshold has no effect: the command is
  promoted first.
- Pass `name` to choose the runner name. A name already in use gets a numbered
  suffix.

## CLI

Run the CLI directly, without starting it through another supervised runner.
It inherits `PI_SESSION_ID` from the active Pi session and only accesses that
session's runners. A manual shell without `PI_SESSION_ID` fails closed.

Use the unique runner ID returned by `bash`:

| Command                                            | Purpose                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| `doom-runner list [--all]`                         | List active runners, or include completed ones |
| `doom-runner status <id>`                          | Show command, state, backend, and log path     |
| `doom-runner logs <id> [--lines N] [--follow]`     | Read or stream the saved log                   |
| `doom-runner stop <id> [--reason <text>]`          | Stop one runner and keep its log               |
| `doom-runner stop-all [--reason <text>]`           | Stop active runners owned by this Pi session   |
| `doom-runner input <id> [--text <text>] [--enter]` | Send input to an interactive RMUX runner       |

## Rules

- **Read the log, do not re-run the command.** When output is truncated, the
  full text is already on disk. Use `doom-runner logs <id>` or standard file
  search tools against the reported path.
- **Read the truncation notice before reading the file.** It states the real
  file size and line count, so you do not read past the end.
- **CLI access is session-scoped.** `list`, direct ID commands, and `stop-all`
  only access runners owned by the inherited Pi session.
- **`input` needs `interactive: true`.** A normal runner does not expose stdin.
- **Stop what you no longer need.** Everything still running is stopped when
  the session ends, but a forgotten dev server holds a port until then.
- **Do not poll.** Check a runner when you have a reason to, not on a loop.

## Where things live

Run metadata and logs sit under
`$PI_CODING_AGENT_DIR/doom-runner/<session-id>/{runs,logs}`. Without an
override, `$PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`. Completed metadata
and complete raw logs remain readable for seven days.

RMUX is bundled for supported macOS and Linux platforms. Non-interactive runs
fall back to a supervised subprocess when RMUX is unavailable; interactive runs
require RMUX. Eligible simple commands use a command-specific RTK stdin filter
after completion. Compound shell commands and unsupported formats keep bounded
raw output.

`SPC r l` opens Runner Space. Escape returns from logs or an attached terminal.
