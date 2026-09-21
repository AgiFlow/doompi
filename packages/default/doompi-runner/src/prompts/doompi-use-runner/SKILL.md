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

Remote MCP does not guarantee that completion notifications resume a ChatGPT
conversation. Retrieve a bounded status or log result during the current turn
when needed. Otherwise report that the run is still active with its identifier.
Do not promise automatic follow-up, continuously poll, or relaunch uncertain work.

- Inspect logs instead of relaunching a command whose status is uncertain.
- Stop watchers, servers, and failed interactive processes when they are no longer needed.
- Treat commands as running with the Doom Pi process environment and the operating-system user's privileges.
- Treat logs as sensitive because they may contain prompts, source, output, or credentials.
