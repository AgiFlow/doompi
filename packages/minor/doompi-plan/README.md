# @agimon-ai/doompi-plan

A reviewable planning lifecycle for Pi with narrowed tools, plan storage, normal, debug, and
Fable-assisted flows, and explicit completion.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Plan mode removes `edit` and `write` from the active tool set and directs writes through
`write_plan`. It does not sandbox Bash, external tools, or the operating system, so treat it as
tool-level workflow protection rather than a repository permission boundary.

> **Alpha:** planning flows and tool contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.3

## Install

DoomPi includes Plan in every composition; Plan mode itself remains inactive until requested. For
standalone Pi:

```bash
pi install npm:@agimon-ai/doompi-plan
```

DoomPi and standalone Pi use the same `@agimon-ai/doompi-plan/extensions/pi` extension.

## Start and exit

| Key       | Flavor                                                 |
| --------- | ------------------------------------------------------ |
| `SPC p e` | Normal planning, and the way out once any flavor is on |
| `SPC p d` | Debug planning with a bounded evidence packet          |
| `SPC p f` | Fable-assisted drafting followed by Pi verification    |

`SPC p e` reads `enter` while the mode is off and `exit` while it is on, where exiting restores the
prior model, thinking level, and tool state.

Normal planning expects repository exploration and delegation where available. Debug planning
separates verified evidence from hypotheses. Fable is an optional Team-provided planning service.
When Team provides `doom/fable-plan`, Plan treats returned text as untrusted and requires Pi to
verify and synthesize the final plan. Its child capability ceiling comes from
`doom/subagent-policy` and is removed when either provider or Plan unloads.

A model or tool restoration failure leaves the narrowed Plan state active and reports the failure
rather than pretending the session was restored.

## Write and complete a plan

`write_plan` accepts visible Markdown plan content and writes a unique file under `~/.pi/plans` by
default. It refuses a plan that is empty or was not presented in visible assistant output, and it
validates the destination before writing. The plan path and content become visible session state.

After a plan exists, `complete_plan` asks whether to exit or continue planning. The user must
explicitly approve exit. If the selected mode already exposes `ask_user_question`, Plan reuses it;
it does not activate an omitted feedback layer.

In autonomous Voice mode, review choices are narrated, the turn terminates, and the next user
message carries the decision.

## Read and edit the plan in the cockpit

Once `write_plan` succeeds, a `plan` group appears in the cockpit's activity dock and stays for the
rest of the session, including after Plan mode is exited: that is when the agent starts
implementing, which is when the plan is most worth having open. The row opens a temporary tab that
renders the plan as Markdown, with a `source` view that edits it and saves back to the plan file.

The agent reads the plan file at the start of every turn, so a saved edit is what it implements. A
save carries the hash the reader loaded and is refused if the agent rewrote the plan in the
meantime, rather than overwriting it.

The cockpit reaches the plan through this package's session API, mounted at `/api/plugin/plans`.
Because a host imports the built entry, a change here needs `pnpm build` and `doompi sync` before a
running cockpit sees it.

## Configure models and storage

Put planning settings in the repository's `.doom/config.yaml` or the global
`~/.pi/.doom/config.yaml`:

```yaml
modes:
  planning:
    main:
      model: provider/planning-model
      thinking: high
    subagents:
      model: provider/research-model
      thinking: medium
    plansDirectory: ~/.pi/plans
```

`main` controls the planning model, `subagents` controls delegated research defaults, and
`plansDirectory` can be absolute, repository-relative, or under `~`. Planning and delegated model
calls consume provider quota.

## Public API

The root exports planning configuration schemas, prompts, Fable flow helpers, and the Plan mode
service. Focused exports include `/config`, `/planConfig`, `/planMode`, `/fableFlow`, and `/prompts`.
`/session-api` is the entry a host mounts for the cockpit's plan tab.

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
