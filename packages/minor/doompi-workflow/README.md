# @agimon-ai/doompi-workflow

Asynchronous workflow discovery, launch, monitoring, control, and recovery from terminal failures
for DoomPi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

The integration embeds `@agimon-ai/workflow-mcp`. Workflow files describe job dependencies and
host-executed steps, while DoomPi provides session-scoped tools and TUI surfaces.

> **Alpha:** workflow and recovery contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.3 and Pi TUI 0.84.3

## Install

DoomPi includes Workflow in every composition; its tools remain inactive until Workflow mode is
enabled. For standalone Pi:

```bash
pi install npm:@agimon-ai/doompi-workflow
```

Enable tools with `SPC w e`, or set `WORKFLOW_MCP_MODE=on` for a non-interactive harness that cannot
toggle the minor mode.

## Define a workflow

Create a `*.workflow.yml` file:

```yaml
name: verify

jobs:
  test:
    steps:
      - name: Run tests
        run: pnpm test

  summarize:
    needs: test
    steps:
      - name: Record result
        run: node scripts/write-verification-summary.mjs
```

`run` commands execute on the host with the workflow process's environment and privileges. There is
no VM, container, or sandbox. Review workflow files as executable code. Runner-specific
`interactiveRun` mappings are available for commands that require a TTY.

## Launch and monitor

Core tools are:

- `list_workflows`: discover workflows.
- `launch_workflow`: register and start an asynchronous run.
- `workflow_run`: inspect or control a run through supported actions.

Launch returns after the run is registered, not after all jobs complete. Use status and follow
controls for progress, and wait for a terminal notification.

In the TUI, `SPC w l` lists the repository's workflows and launches the one under the cursor with
`r`, `SPC w r` inspects this session's runs, `SPC w c` opens recovery, and `SPC w e`
toggles model-visible tools. The root session can launch; child sessions can inspect the catalog but
do not receive an unrestricted workflow factory.

## Storage, concurrency, and lifecycle

Registry data defaults to `$HOME/.workflow-mcp`; set `WORKFLOW_MCP_HOME` to relocate it. Persisted
records contain workflow and run identity, job and step state, ownership, output locations, and
recovery evidence. The default concurrency ceiling is five runs.

Runs embedded directly in the Pi process end with that process. Runs launched through a terminal
host such as tmux or cmux can have a different lifetime and remain manageable from the CLI. When
Team is loaded, Workflow contributes active session runs through Team's `doom/background-work`
service. That contribution reconnects after Team is replaced and is removed when Workflow unloads.
Reconciliation distinguishes stale registry records from live processes; do not assume every run
outlives its parent session.

Each workflow or repair step can launch commands and model-backed agents, consuming provider quota
and repeating external side effects.

## Recovery

Recovery is available only for records in a terminal failure state. A recovery claim atomically
adopts the eligible failure, validates the evidence, and transfers ownership to the replay session.
Live controls remain scoped to the owning session. Recovery does not launch a second copy beside a
still-running job and does not guarantee that parent-session work survives shutdown.

The package publishes `workflow-recovery` for active Workflow mode. While parent Help mode is
active, it also contributes `doompi-author-workflow` for writing workflow definitions and
`doompi-use-workflow` for launching, monitoring, and recovering runs. Deactivating Help hides both
descriptors; cached files may remain.

Each Pi extension instance uses the runner's shared Doom lifecycle. Reload or shutdown stops retained
callbacks, interrupts bounded inline work, removes UI and service registrations, and releases
package resources. Detached children load the same extension entry in their own process.

## Pi extension

The Pi extension is published at `@agimon-ai/doompi-workflow/extensions/pi` and declared in
`package.json.pi.extensions`. Installing the package loads it automatically; there is no secondary
registration or dispatcher export.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Maintained by [Agimon](https://agimon.ai/about).

## Web cockpit plugin

The `web/` directory is this package's DoomPi web cockpit plugin: the workflows tab, its store,
and its `workflow_runs` session channel, compiled into the cockpit bundle by `doompi-web`'s build.
The hub-side data source ships behind the `./web-hub` subpath and reads the workflow registry
(run.json plus progress.ndjson) exactly as the engine writes it. Both halves are declared by the
`doompiWeb` block in package.json.

## License

MIT, except the `web/` directory, which is source available under the DoomPi Web License (see
`web/LICENSE`): free to use, including commercially, but not to redistribute.
