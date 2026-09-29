# Automation

[Back to DoomPi](../README.md)

DoomPi has two ways to keep work moving:

```text
Loop      repeats a prompt inside one live session
Workflow  runs a dependency graph with a separate DoomPi session per step
```

Use Loop when the work belongs in one conversation. Use Workflow when jobs need explicit dependencies, timeouts, artifacts, or different compositions. A loop can also dispatch workflows, keeping the schedule in one session while the work runs in fresh ones.

Commands in this guide run from the repository root.

## Workflow execution model

Workflow mode reads GitHub Actions-style job graphs. `needs` orders jobs. Each `interactiveRun` starts the command written in the workflow, so the definition owns the mode, domains, working directory, and other launch policy for that step. Workflow steps run with the host process's environment and privileges, not in a VM or sandbox.

```text
workflow definition
       |
       +-- job: implement -> DoomPi session A
       |          |
       |          +-- artifacts and result
       |
       +-- job: article, needs implement -> DoomPi session B
```

Steps do not inherit the dispatcher's entire toolbox. This is the main reason to use separate sessions: implementation can load development tools while writing can load only the blog domain.

```yaml
on:
  workflow_dispatch:

jobs:
  implement:
    steps:
      - name: Build the feature
        timeout-minutes: 180
        interactiveRun: |
          doompi --major-mode examples --domains development --auto-stop \
            --cwd "$PWD" "$JOB_SYSTEM_PROMPT"

  article:
    needs: implement
    steps:
      - name: Write the article
        timeout-minutes: 30
        interactiveRun: |
          doompi --major-mode examples --domains blog --auto-stop \
            --cwd "$PWD" "$JOB_SYSTEM_PROMPT"
```

`--auto-stop` closes the interactive Pi session after its agent settles. Timeouts remain workflow policy and should reflect the cost and expected duration of each job.

### In-process steps: `runConfig` and `customRun`

A step can declare its DoomPi settings as data instead of CLI flags. `runConfig` holds what every runner of the step shares, and `customRun` holds only what the in-process runner needs:

```yaml
- name: Diagnose the defect
  artifacts: [diagnosis.md]
  runConfig:
    majorMode: examples
    minorModes: [plan]
    profile: work
    domains: [engineering]
    model: openai-codex/gpt-6-sol
    thinking: medium
  customRun:
    prompt: |
      ${{ env.JOB_SYSTEM_PROMPT }}

      Defect report:
      ${{ env.WORKFLOW_CONTEXT }}
  interactiveRun: |
    doompi --major-mode ${{ runConfig.majorMode }} --domains ${{ runConfig.domains }} \
      --auto-stop --cwd "$PWD" "$JOB_SYSTEM_PROMPT"
```

When the DoomPi server launches a workflow (the `launch_workflow` tool, `/workflow-launch`, or the web launch dialog), the run executes in the server process and `launch-command` is not used:

- A `customRun` step, or a templated command that allows `inProcess`, becomes a child session of the launching session, pinned to the step's major mode, minor modes, profile, domains, and model. The step's view in the workflow panel shows that session's live conversation where a command step shows its terminal. Each time the agent settles, the engine's gate is asked: while the step still lacks its decision or declared artifacts, the agent is reminded, up to the gate's cap, and guidance sent from the web while it works is left to finish first. The step fails on a harness fault, on a session that cannot be opened (with the host's reason), and when a declared artifact was not written. Once the step ends, its session is released: it stops holding a model and tools but stays readable, as a dormant session, in the workflow's view.
- Every run keeps its engine log in `engine.log` in its run directory, which the artifacts pane lists, and a failed step records why in its progress entry. Engine errors, run starts, finishes, and failures also go to telemetry as `doom_workflow.*` events.
- Closing the session that launched a run asks the run to stop.
- `run` and `interactiveRun` steps each get their own RMUX pane, which the job's terminal view follows. Without a compatible RMUX binary, the step is spawned by the engine as before.

`runConfig` keys are validated: `majorMode`, `profile`, `model`, and `thinking` take one name, while `minorModes` and `domains` take a list or a comma-separated string (an empty list selects no domains). An unknown key fails the step; on a templated step, a key the template of any command the step offers reads is known too.

Check workflows before running them with `workflow-mcp doctor`, which reports what a run would otherwise only meet mid-step: schema and import problems, runConfig keys nothing reads, jobs that need a missing job, runner maps no runner satisfies, customRun steps without a terminal fallback, and inputs a workflow does not declare. Pass DoomPi's keys so runConfig typos are errors:

```bash
workflow-mcp doctor automations/workflows --run-config-keys majorMode,minorModes,profile,domains,model,thinking
```

It exits non-zero on errors (and on warnings with `--strict`), and `--format json` reports each finding with its code and location. The DoomPi server runs the same check on its workflow catalog: a workflow with errors shows as needing fixing and cannot be launched until it is fixed. `${{ runConfig.<key> }}` interpolates into any command, with lists joined by commas, and `WORKFLOW_RUN_CONFIG` holds the whole map as JSON.

The CLI and the TUI have no in-process executor. They run a step's `interactiveRun` or `run` instead, so keep one as a fallback. A step with only `customRun` fails there with an explicit error.

## Repository examples

This repository carries a small native plugin and workflow stack:

```text
plugins/
  development/   implementation skill and developer agent
  testing/       testing and review skills, tester and reviewer agents
  blog-writing/  research, outline, drafting, and editorial skills and agents
automations/workflows/
  dev-feature.workflow.yml
  dev-fix.workflow.yml
  blog-writing.workflow.yml
```

Each plugin has Codex and Claude plugin manifests while sharing its `skills/` and `agents/` content. `.doom/domains.yaml` exposes the `development`, `testing`, and `blog` domains plus the `engineering` alias. `.doom/modes.yaml` uses workspace-local package paths and adds the layer-free `examples` major mode for these workflows.

Inspect the exact session before launching it:

```bash
doompi --major-mode examples --domains engineering --explain
doompi --major-mode examples --domains blog --explain
```

The same plugins can be installed through the native Codex and Claude Code marketplaces. DoomPi adds no private plugin schema:

```bash
# Codex
codex plugin marketplace add .
codex plugin add development@doompi-examples

# Claude Code
claude plugin marketplace add ./ --scope user
claude plugin install development@doompi-examples --scope user
```

Substitute `testing` or `blog-writing` for another plugin.

## Validate before spending a model call

List and dry-run workflow definitions first:

```bash
pnpm exec workflow-mcp list-workflows automations/workflows
pnpm exec workflow-mcp run-workflow automations/workflows/dev-feature.workflow.yml \
  --dry-run --skip-launch --prompt "Add a health check"
pnpm exec workflow-mcp run-workflow automations/workflows/blog-writing.workflow.yml \
  --dry-run --skip-launch --prompt "Write a practical guide to scoped agent tooling"
```

The tracked workflows allow two concurrent runs and launch through tmux by default. Set `WORKFLOW_LAUNCHER=cmux` to use cmux. The development workflows do not create branches, commits, or pushes. The blog workflow writes Markdown, sources, and a publication checklist into its run directory. It does not publish to a site or CMS.

These examples are repository fixtures and are not included in the published npm package.

## Loop as a dispatcher

Loop mode runs a prompt immediately and repeats it inside the current session. The default interval is 300 seconds, and accepted intervals range from 30 to 3,600 seconds. If Pi is busy, a due pass waits; multiple due signals can coalesce instead of creating overlapping turns.

Loop state is not a durable queue. Replacing or closing the session stops its timers, and reopening a transcript does not restart them. Workflow definitions are exposed like skills, so a loop can ask a subagent for the next task and launch the matching workflow.

That keeps scheduling and routing in one live session while each unit of work gets a fresh, explicit composition. Use Workflow instead when the work needs durable dependency records or isolated artifacts.

See [Features](features.md#modes-and-automation) for the user-facing controls and [Configuration](configuration.md) for selecting the packages that provide them.
