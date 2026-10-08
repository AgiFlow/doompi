---
name: doompi-use-runner
description: Use Doom Pi Runner to supervise shell commands, inspect durable logs, provide interactive input, and stop background runs.
---

# Use Doom Pi Runner

Use Runner for shell work that may outlive one tool call, needs durable logs, or requires later inspection and control.

## Launch work

- Use the Runner-provided `bash` tool for shell commands.
- Let short commands return inline.
- Set `background: true` when the command should detach immediately.
- Set `interactive: true` only when the process genuinely needs terminal input.
- `timeout` only governs the foreground wait. A command promoted to the background can continue past it; do not treat it as a background deadline.

## Inspect and control work

For remote MCP, run the following commands through `bash`. They inherit the
bound session; do not supply another session ID. `/runners` and `SPC r l` are
local TUI interfaces, not shell commands or remote tools. For direct control, use:

```bash
doom-runner list
doom-runner status <runner-id>
doom-runner logs <runner-id> --lines 100
doom-runner input <runner-id> --text "y" --enter
doom-runner stop <runner-id>
doom-runner stop-all
```

Input requires a running interactive process backed by RMUX. Preserve the returned runner identifier because it remains usable after transcript compaction.

## Close the lifecycle

Remote MCP never receives runner completion notices, and a runner you start
does not resume your conversation when it ends. While a runner matters to your
task, check `doom-runner status <id>` between steps of your own work and read
`doom-runner logs <id> --lines 100`. Stop checking when State is completed, and
report a runner that is still running with its identifier. Do not promise
automatic follow-up or relaunch uncertain work.

- Inspect logs instead of relaunching a command whose status is uncertain.
- Stop watchers, servers, and failed interactive processes when they are no longer needed.
- Treat commands as running with the Doom Pi process environment and the operating-system user's privileges.
- Treat logs as sensitive because they may contain prompts, source, output, or credentials.
