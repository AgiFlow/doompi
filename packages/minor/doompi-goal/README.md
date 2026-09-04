# @agimon-ai/doompi-goal

Keep one objective, an optional token budget, and completion tools active across Pi turns.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Completed, cleared, or blocked goals no longer contribute active instructions or tools. Goal history
is scoped to the repository.

> **Alpha:** Goal behavior may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.85.0 and Pi TUI 0.85.0

## Install

DoomPi includes Goal as a built-in minor mode that starts inactive. For standalone Pi:

```bash
pi install npm:@agimon-ai/doompi-goal
```

## Command grammar

```text
/goal <objective>
/goal --tokens 100k <objective>
/goal status
/goal pause
/goal resume
/goal edit [--tokens 1.5m] <objective>
/goal clear
```

Budgets accept compact values such as `100k` and `1.5m`. Goal adds `goal_complete` and
`goal_blocked` only while host policy permits and the objective is operational. An active Goal
continues after genuinely idle turns. In a composed DoomPi session it waits for same-session
subagents, tasks, runners, workflows, and their completion turns before continuing. Only a
successful `goal_complete` call marks the objective complete.

In DoomPi, `SPC g e` starts a goal. If another goal is active, it ends and archives that goal first. `SPC g g` shows status, and `SPC g l` opens history. These views require a TUI; slash commands and tools support headless operation.

## In the cockpit

Once a session sets a goal, a `goal` group appears in the activity dock carrying the objective and
how far along it is. Its kebab menu edits the objective and the token budget, or removes the goal,
both through the same `/goal` verbs the terminal uses, so an edit made in either place is one
operation. Removing archives to goal history and stops the turn in flight, so it asks first.

## Settings

Settings live in `$PI_CODING_AGENT_DIR/pi-goal.json` (default `~/.pi/agent/pi-goal.json`). The
defaults use operational tool visibility, allow unlimited automatic turns, and pause after three
no-progress turns. Hosts can decode and normalize custom settings through the public settings API.

## State and history

Live Goal state is stored in Pi session entries. History is repository-scoped under:

```text
$PI_CODING_AGENT_DIR/goal-history/
```

The default history path is `~/.pi/agent/goal-history/`. History retains up to 100 entries and
1 MiB. Corrupt history files are quarantined instead of being interpreted as valid goals. Clearing
or completing removes active instructions and tools; archived history remains until retention or
explicit deletion removes it.

## Public API

```ts
import {
  DEFAULT_GOAL_SETTINGS,
  parseGoalCommand,
  parseTokenBudget,
  registerGoalExtension,
} from '@agimon-ai/doompi-goal';
```

The root also exports state-machine, history codec, accounting, safety, prompt, and tool
types for embedding.

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
