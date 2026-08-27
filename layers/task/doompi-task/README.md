# @agimon-ai/doompi-task

Track persistent, dependency-aware tasks in Pi and optionally delegate them through DoomPi Team.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Task owns task records and `tasks.json`. Team owns agents and runs. When both are loaded, Task delegates pending work through Team without merging their stored state.

> **Alpha:** task and delegation contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.3 and Pi TUI 0.84.3

## Install

Add Task to a DoomPi layer:

```yaml
layers:
  task:
    packages: ['@agimon-ai/doompi-task']

majorMode:
  minimal:
    description: Lean mode with persistent tasks.
    layers: [task]
```

For standalone Pi:

```bash
pi install npm:@agimon-ai/doompi-task
```

Task works without Team for local graph management. Add `@agimon-ai/doompi-team` to the same
selected mode when `assign` and `cancel` should launch or control subagents.

## Use the `task` tool

Supported actions are:

| Action        | Purpose                                                            |
| ------------- | ------------------------------------------------------------------ |
| `upsert`      | Create tasks or update status, metadata, dependencies, and details |
| `list`, `get` | Read the graph or one task                                         |
| `delete`      | Tombstone a task                                                   |
| `clear`       | Close and reset the graph after active delegations stop            |
| `assign`      | Delegate a pending, unblocked task through Team                    |
| `cancel`      | Stop a delegated run and return its task to pending                |

```json
{
  "action": "upsert",
  "tasks": [
    { "ref": "design", "subject": "Design the API" },
    {
      "subject": "Implement the API",
      "blockedBy": ["design"]
    }
  ]
}
```

The reducer enforces lifecycle transitions and rejects dependency cycles. A graph allows 15
non-deleted tasks by default; updates still apply when full, but new tasks are rejected until space
is freed.

## TUI

Use `/tasks` or `SPC t l` to open the interactive task view. These surfaces require a TUI. The
`task` tool remains available in headless sessions.

## Storage and cleanup

The default session-tree store is:

```text
~/.pi/agent/doom-task/<session>/tasks.json
```

Task is authoritative across transcript compaction because the graph is file-backed. This does not
mean Task persists Team membership, intercom, or child-process state.

Defaults and overrides:

| Setting                           | Default        | Purpose                                    |
| --------------------------------- | -------------- | ------------------------------------------ |
| `DOOM_TASK_MAX_TASKS`             | `15`           | Maximum non-deleted tasks                  |
| `DOOM_TASK_STORE_TTL_MS`          | 30 days        | Retention for inactive session-tree stores |
| `DOOM_TASK_DELEGATION_TIMEOUT_MS` | 20 minutes     | Delegated-run result timeout               |
| `DOOM_TASK_STORE`                 | Unset          | Override the complete store file path      |
| `DOOM_TASK_COLLAPSE_KEY`          | `ctrl+shift+t` | Override the task-view collapse key        |

Startup reconciliation removes expired stores and repairs delegation records whose owning process
is no longer live.

## Task and Team together

Task uses Team's delegation service and records its lifecycle events on the task. It also contributes
pending assignments through `doom/background-work`. Team discovers the selected agent, applies
model and tool policy, owns the run, and returns completion or failure. If Team unloads or is
replaced, both connections are removed and rebound without leaving a process-global registration.
Intercom and Team membership remain Team state; `tasks.json` remains Task state.

## Public API

```ts
import { detectCycle, isBlocked, TaskStore, taskExtension } from '@agimon-ai/doompi-task';
import type { Task, TaskStatus } from '@agimon-ai/doompi-task';
```

Focused exports cover schemas, reducers, storage, invariants, delegation management, tool responses,
and TUI selectors.

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
