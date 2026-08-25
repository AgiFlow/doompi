# @agimon-ai/doompi-goal

A Pi minor mode that keeps one objective, an optional token budget, and completion tools active
across turns.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Completed, cleared, or blocked goals no longer contribute active instructions or tools. Goal history
is scoped to the repository.

> **Alpha:** Goal behavior and experimental queue commands may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.3 and Pi TUI 0.84.3

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
`goal_blocked` only while host policy permits and the objective is operational.

In DoomPi, `SPC g e` starts a goal and ends and archives the one being worked, `SPC g g` shows
status, and `SPC g l` opens history. These views require a TUI; slash commands and tools support headless operation.

## Experimental queue

Queue commands are disabled by default. Set `experimental.goals` to `true` in
`$PI_CODING_AGENT_DIR/pi-goal.json` (default `~/.pi/agent/pi-goal.json`) to enable `/goal add`,
`/goal prioritize`, `/goal skip`, and `/goal drop-last`. Treat this queue as experimental rather
than part of the stable single-objective contract.

Default settings use operational tool visibility, disable the queue, allow unlimited automatic
turns, and pause after three no-progress turns. Hosts can decode and normalize custom settings
through the public settings API.

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

The root also exports state-machine, queue, history codec, accounting, safety, prompt, and tool
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
