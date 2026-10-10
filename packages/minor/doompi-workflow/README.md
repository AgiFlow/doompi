# @agimon-ai/doompi-workflow

Discover, launch, monitor, control, and recover asynchronous DoomPi workflows.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

The integration embeds `@agimon-ai/workflow-mcp`. Workflow files describe job dependencies and
host-executed steps, while DoomPi provides session-scoped tools and TUI surfaces.

> **Alpha:** workflow and recovery contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 1.0.0 and Pi TUI 0.85.0

## Install

The seeded `modes.yaml` selects Workflow in `default.packages`. Keep it there or select it through
a layer; its tools remain inactive until Workflow mode is enabled. For standalone Pi:

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

A step can also declare `runConfig` (major mode, minor modes, profile, domains, model, thinking)
and `customRun` (a prompt). Launched from the DoomPi server, a `customRun` step runs as a child
session of the launching session with those settings, until the agent has recorded what the step
needs, and `run` and `interactiveRun` steps each get their own RMUX pane. Each run keeps its engine
log in `engine.log` in its run directory. See `docs/automation.md` for the full contract and the
CLI fallback.

## Launch and monitor

Core tools are:

- `list_workflows`: discover workflows.
- `launch_workflow`: register and start an asynchronous run.
- `workflow_run`: inspect or control a run through supported actions.
- `workflow_tools` (server/web sessions): read failed-run recovery evidence or resume the existing run.

Launch returns after the run is registered, not after all jobs complete. Use status for progress
and wait for a terminal notification. The TUI also supports follow controls.

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

The package publishes `workflow-recovery`, `doompi-author-workflow` for writing workflow
definitions, and `doompi-use-workflow` for launching, monitoring, and recovering runs while Workflow
mode is active. Deactivating Workflow mode hides them; cached files may remain.

## Workflow sessions

In a server (web cockpit) session, a launch does not run in the session that asked for it. The
session creates a child **workflow session** (provenance `workflow-session`), nested under it in the
rail, and hands it the launch. The workflow session owns the run (`PI_SESSION_ID`), runs its step
sessions, and has Workflow mode on, so its agent can troubleshoot and recover the run. The run's
environment also carries `DOOMPI_WORKFLOW_LAUNCHER_SESSION_ID`, naming the launching session, which
lists the run in its Activity group, is told when it completes, and may read its status. Failures only
raise a UI toast there, without adding a message to the launching agent's context.

- The workflow session's rail row shows the run (`workflow · build › test · 4m`, or a failure or
  pause marked like a pending question) through the host's per-session activity line.
- A failure starts a turn in the workflow session to diagnose and report locally. Recovery requires
  a user request or explicit launcher delegation. Completion is posted without starting a turn,
  and completion after recovery still notifies the launcher. The owner agent also gets a live brief
  of its runs on every turn.
- After a success, a workflow session nobody interacted with asks its launcher to release it, and it
  becomes `stopped · open to wake`. A session whose run failed or paused, or whose agent you
  prompted, stays live until you remove it. Removing or restarting a live workflow session stops its
  run.
- Recovery is refused from any session other than the owner while the owner is live.

Launches from inside a workflow session, and launches in hosts without a session service (the TUI
and CLI), run in place as before.

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

The `.web` routed files under `src/extensions/workspaces/sessions/(frontend)` are this package's
DoomPi web cockpit plugin: the `workflow` dock face beside Activity and Context (the owned run's
jobs, active steps and artifacts, each opening its own tab), the workflow catalog and launch
dialog in the overlay slot, the Activity group's run rows (a handed-off run opens its workflow
session), their stores, and the `workflow_runs` session channel, compiled into the cockpit bundle
by `doompi-web`'s build. Each surface keeps its components in a colocated `_components` folder and
its stores and helpers in `_lib`.
The hub-side data source ships behind the `./web-hub` subpath and reads the workflow registry
(run.json plus progress.ndjson) exactly as the engine writes it. Both halves are declared by the
`doompiWeb` block in package.json.

## License

MIT, except this package's browser half (the `.web` routed files under `src/extensions` and the
`_components` and `_lib` modules colocated with one), which is source available under the DoomPi
Web License (see `LICENSE.web`): free to use, including commercially, but not to redistribute.

Workflow's host entries live in `src/extensions/pi.ts`, `server.ts`, and `web.ts`.
`src/exports` exposes reusable package APIs. Controllers declare server APIs and
contributions, tools declare native tools, and each service has its own folder.
Terminal presentation and its session coordinator live in `src/tui`.

The Pi helper owns registrations and service fibers. The Workflow runtime returns
commands, events, mode ownership, and tool dependencies. Session startup begins
readiness discovery; dependent calls await that session's readiness. On shutdown,
`onStop` interrupts inline runs and clears session resources, while `onDispose`
also handles startup failure. Both use the same idempotent cleanup. A generation
fence prevents retired callbacks from sending messages or updating the UI; only
explicit resource teardown may use a retired UI context.

## Step completion

In-process steps wait, without a timeout or decision reminders, for the child session to be idle with no queued messages or owned subagent/task/runner work. Cancellation interrupts this wait. Missing coordinator snapshots and holding-provider errors defer the decision gate; a failed inspection fails the step. Workflow monitoring itself does not hold completion.

Pi terminal steps must load this package: its native settled handler owns the decision gate, not generic `hooks.yaml`. It skips host-steered sessions and subagents, and defers the gate while owned background work remains. Missing pane coordinators retain the no-work fallback; snapshot failures defer gating with a diagnostic.
