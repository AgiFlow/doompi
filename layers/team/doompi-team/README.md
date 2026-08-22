# @agimon-ai/doompi-team

An asynchronous subagent runtime for Pi: agent discovery, background runs, membership, intercom,
and model and tool policy.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Team does not own Task's graph. When both packages are loaded, Team fulfills Task delegation
requests while Task remains the source of truth for task status and dependencies.

> **Alpha:** run, policy, and intercom contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` 0.84.2

## Install

Add Team to a DoomPi layer. Add Task separately when you want graph-backed delegation:

```yaml
layers:
  coordination:
    packages:
      - '@agimon-ai/doompi-task'
      - name: '@agimon-ai/doompi-team'
        config:
          models:
            - model: provider/model-id
              thinking: high
          excludeTools: [ask_user_question]

majorMode:
  development:
    description: Development with tasks and delegated agents.
    layers: [coordination]
```

For Team without Task in standalone Pi:

```bash
pi install npm:@agimon-ai/doompi-team
```

Team-only sessions can launch and manage agents directly; they simply have no Task-owned graph to
update.

## Commands and tools

Slash commands include:

```text
/run
/parallel
/subagents-doctor
/subagents-stop
/subagents-list
/subagents-fleet
```

Use `/run` for one agent, `/parallel` for several, `/subagents-doctor` for diagnostics,
`/subagents-stop` to stop work, `/subagents-list` for available agents, and `/subagents-fleet` for
current runs.

The `subagent` tool exposes `agents`, `run`, `status`, `steer`, `stop`, `suspended`, and `restore`.
The `intercom` tool exposes `members`, `send`, `ask`, `pending`, and `reply`.

Use `SPC a l` to browse agents and `SPC a r` to inspect current-session runs. TUI views require an
interactive host; tools and commands support headless orchestration.

## Run lifecycle

Runs are asynchronous. The parent receives a run identifier and later completion or failure rather
than an inline child transcript. A shutdown requests suspension and writes restorable state. A later
session can list suspended work and explicitly restore it. Reopening does not automatically restart
children, and Team does not promise that every run continues after its parent exits.

The root session scopes run results, transcripts, control inboxes, membership, intercom, and
suspended records. State is stored in private, per-user temporary directories with per-session
subdirectories. Suspended records are recoverable only while those temporary files remain. Launch
contracts can contain full prompts and are written with private permissions, then removed after
handoff. Intercom messages expire after 24 hours; liveness checks remove stale membership and run
state.

## Model and tool policy

Package configuration belongs on the Team package entry. When several selected entries contribute
configuration, later entries replace the `models` list and `excludeTools` values are combined in
layer order.

Agent configuration, explicit launch options, Team policy, and provider availability determine the
final model and tools. A child cannot exceed the capability ceiling supplied by its parent or
provider policy. Allowed MCP and stdio tools can execute commands, so treat agent definitions and
the inherited environment as trusted configuration.

## Task delegation bridge

With Task installed:

1. Task selects a pending, unblocked task and sends a delegation request.
2. Team resolves the named agent, context, model, skills, and capability policy.
3. Team owns the background run, messaging, steering, and suspension.
4. Task records the terminal result on its own task.

This is a named Cordis service relationship, not shared persistence. Team provides
`doom/delegation`, `doom/background-work`, `doom/subagent-policy`, and `doom/fable-plan` for the
active session. Consumers disconnect and reconnect automatically when that provider changes.

## Public API

```ts
import { resolveSubagentLaunchContract } from '@agimon-ai/doompi-team';
```

Focused subpaths expose the pure capability-ceiling codec, compatibility delegation payload types,
and team-snapshot contracts. Live cross-extension collaboration contracts come from
`@agimon-ai/doompi-extension-contracts`; the standard Pi extension is available at `/extensions/pi`.

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
