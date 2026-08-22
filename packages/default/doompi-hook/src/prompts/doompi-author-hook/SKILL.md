---
name: doompi-author-hook
description: Author DoomPi repository or plugin hooks. Use when creating or changing .doom/hooks.yaml, selecting hook groups from modes.yaml, writing hook commands, or adapting Claude Code hook payloads and decisions to DoomPi.
---

# Author DoomPi hooks

Write the smallest hook that enforces the requested policy, and treat every hook command as executable repository code.

## Repository registry

Define repository and personal hooks in `.doom/hooks.yaml`:

```yaml
groups:
  safety:
    core: true
    hooks:
      - event: PreToolUse
        pi:
          matcher: Bash
          command: .doom/hooks/guard-destructive-commands.sh
          timeout: 10
          skipInSubagent: true
          order: 0
```

- Personal configuration comes from `~/.pi/.doom/hooks.yaml`; repository configuration comes from `<repo>/.doom/hooks.yaml`.
- A repository group replaces a personal group with the same ID as one complete value.
- `core: true` runs regardless of the selected groups. Otherwise, add the group ID to a layer's `hookGroups` in `modes.yaml`.
- `matcher` is a regular expression over Claude tool names such as `Bash` and `Write`, even though Pi uses lowercase tool names internally.
- Use `skipInSubagent: true` when running the hook in a child could duplicate or close parent-owned work. Lower `order` values run first, with declaration order as the tiebreaker.

Supported repository events are `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop`. `SessionEnd` is resolved only from plugin `hooks.json` documents.

## Command contract

DoomPi runs each command through `/bin/bash -c` from the repository root and writes the Claude-compatible event payload to stdin. The environment includes `CLAUDE_PROJECT_DIR`, `CODEX_REPO_ROOT`, `ORIGINAL_REPO_PATH`, and `CLAUDE_PLUGIN_ROOT`. For `.doom/hooks.yaml`, `CLAUDE_PLUGIN_ROOT` is the root that declared the personal or repository document.

The final stdout line beginning with `{` is parsed as the hook decision. Use Claude Code decision fields only when the event supports them. `PreToolUse` may deny a tool or add context, `PostToolUse` may append context or mark a result as denied, and `SessionStart` may add context. `Stop` and `SessionEnd` run for side effects.

Hook failures are advisory: nonzero exits, invalid JSON, spawn failures, and timeouts are reported to the agent instead of crashing the turn. Set `timeout` in seconds only when the 10-second default is unsuitable. A timeout terminates the command's process group.

## Verification

Before enabling a new hook broadly:

1. Run the command directly with a representative JSON payload on stdin.
2. Start DoomPi with the intended major mode and confirm the group appears in `doompi --explain` output.
3. Exercise the exact lifecycle event in a disposable session, including a child session when `skipInSubagent` matters.
4. Confirm failure output reaches the agent and that repeated shutdown does not repeat external side effects unexpectedly.
