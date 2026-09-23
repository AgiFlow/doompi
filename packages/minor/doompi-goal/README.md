# @agimon-ai/doompi-goal

Keep one objective and an optional token budget active across agent turns, with independent idle-time completion checking.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Completed, cleared, or blocked goals no longer contribute active work instructions. Goal history
is scoped to the repository. Lifecycle tools are private to the checker, never added to the working agent.

> **Alpha:** Goal behavior may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.87.1 and Pi TUI 0.87.1
- The DoomPi background-work coordination service for automatic completion checks. If coordination is missing or unavailable, Goal does not assume the session is idle.

## Install

The seeded `modes.yaml` selects Goal in `default.packages`; it is not fixed host infrastructure.
Keep it there or select it through a layer. Goal starts inactive. For standalone Pi:

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

Budgets accept compact values such as `100k` and `1.5m`. Starting or resuming a goal wakes the
agent in both the CLI and server. After a turn settles, Goal waits for same-session subagents,
runners, workflows, and their result handoffs, and for all pending messages to be processed.

One bounded LLM check then evaluates the objective against the transcript and verification evidence.
The checker alone receives `goal_complete`, `goal_continue`, and `goal_blocked`. Completion archives
the evidence and removes the active goal. Incomplete work produces a targeted next-action prompt,
not a generic completion claim. Genuine repeated external blockers retain the unfinished goal.

New work, user input, edits, pause, session changes, or cancellation invalidate an in-flight verdict.
Provider failures and invalid verdicts pause the goal without automatic retry loops. Use `/goal resume`
after resolving the problem. Token and no-progress limits prevent further substantive continuation;
a final idle check may still establish that the already-finished work is complete.

In DoomPi, `SPC g e` starts a goal or ends and archives the current goal. `SPC g g` shows status,
and `SPC g l` opens history. These leader views require a TUI; slash commands support headless operation.

## In the cockpit

Once a session sets a goal, a `goal` group appears in the activity dock carrying the objective and
how far along it is. Its kebab menu edits the objective and the token budget, or removes the goal,
both through the same `/goal` verbs the terminal uses, so an edit made in either place is one
operation. Removing archives to goal history and stops the turn in flight, so it asks first.

## Settings

The CLI reads settings from `$PI_CODING_AGENT_DIR/pi-goal.json` (default
`~/.pi/agent/pi-goal.json`). The defaults allow unlimited automatic turns and pause after three
repeated tool-free outputs. The server uses those default continuation limits. The legacy
`toolVisibility` setting is still decoded for compatibility but no longer exposes lifecycle tools.

## State and history

Live Goal state and `goal-check` audit records are stored in session entries. Checker token usage
is included in Goal budget accounting. History is repository-scoped under:

```text
$PI_CODING_AGENT_DIR/goal-history/
```

The default history path is `~/.pi/agent/goal-history/`. History retains up to 100 entries and
1 MiB. Corrupt history files are quarantined instead of being interpreted as valid goals. Clearing
or completing removes the active objective and status. Archived history remains until retention
or explicit deletion removes it. Failed archival retains the goal instead of discarding it.

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

Plugin entries live in `src/extensions`, with host-neutral runtime logic in `src/services` and host registrations in routed `src/extensions` surfaces. `src/models` owns goal state, accounting, transitions, and serialization. Named `src/services` folders handle history, persistence, prompts, and validation. Public helpers and types are exposed through flat `src/exports`.

Both hosts declare minor-mode owners and use the shared background-work contract. Request-private
checker tools are validated before their effects are applied, with session and goal revision guards.
Provider calls do not hold the command queue, so pause and clear remain responsive during inference.
The main agent's ordinary tool policy is unchanged.
