# @agimon-ai/doompi-hook

Claude Code-compatible repository and plugin hooks for
[DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) sessions.

A **hook** is a shell command the repository runs at a point in the session: before a tool call,
after one, at session start, when the agent settles, and at session end. Commands are declared in
`.doom/hooks.yaml`, grouped so a mode can turn a whole family of them on or off.

> **Alpha:** hook configuration and runtime contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.85.0
- `/bin/bash`

Configure hooks in `.doom/hooks.yaml`:

```yaml
# .doom/hooks.yaml
groups:
  safety:
    core: true
    hooks:
      - event: PreToolUse
        pi:
          matcher: Bash
          command: .doom/hooks/guard-destructive-commands.sh
  workflow:
    hooks:
      - event: Stop
        pi:
          command: .doom/hooks/close-workflow-step.sh
          skipInSubagent: true
```

A group marked `core: true` always loads. Every other group loads only when the active mode selects
it. The same document is read from the global `.doom` directory and from the repository. A
repository group replaces the global group of the same ID outright.

## Activation

The DoomPi distribution activates this package by default. Layers only declare the `hookGroups`
that should run in a major mode:

```yaml
# .doom/modes.yaml
layers:
  repository-hooks:
    hookGroups: [safety, workflow]
```

A session with no selected `hookGroups` still runs groups marked `core: true`; other groups remain
inactive.

## What a hook sees and can say

Each command is run through `/bin/bash -c` in the repository root, with the Claude Code payload for
the event on stdin. The environment includes `CLAUDE_PROJECT_DIR`, `CODEX_REPO_ROOT`, and
`ORIGINAL_REPO_PATH`. Every resolved hook also receives `CLAUDE_PLUGIN_ROOT`, set to the root that
declared its repository, personal, or plugin configuration. Tool names in the payload and in
`matcher` are Claude names (`Bash`, `Write`), not Pi's.

The last stdout line that starts with `{` is read as the hook's decision:

| Event mapping                   | A decision can                                                     |
| ------------------------------- | ------------------------------------------------------------------ |
| `SessionStart` → session start  | add `additionalContext` to the conversation                        |
| `PreToolUse` → tool call        | block the call with a reason, or steer it with `additionalContext` |
| `PostToolUse` → tool result     | append text to the result and mark it an error                     |
| `Stop` → agent settled          | nothing; the hook runs for its side effects                        |
| `SessionEnd` → session shutdown | nothing; plugin hooks only                                         |

A hook that exits non-zero, times out, cannot be spawned, or prints unparseable JSON does not fail
the turn. It is reported to the agent instead, because a guardrail that never ran is otherwise
indistinguishable from one that passed.

## Timeouts

`timeout` is in seconds and defaults to 10. A hook is spawned in its own process group and, when it
expires, is sent `SIGTERM` and then `SIGKILL` two seconds later, so a stalled hook does not leave
the processes it started behind.

## Help guidance

While the Help minor mode is active, this package contributes `doompi-author-hook`. The prompt
covers `.doom/hooks.yaml`, group activation, commands, payloads, decisions, and verification, and
is withdrawn when the package or Help provider unloads.

## Install

DoomPi already includes this package. For standalone Pi installation:

```bash
pi install npm:@agimon-ai/doompi-hook
```

## Public API

```ts
import { createBashHookRunner, hookExtension } from '@agimon-ai/doompi-hook';
import type { HookDecision, HookEventName } from '@agimon-ai/doompi-hook';
```

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
