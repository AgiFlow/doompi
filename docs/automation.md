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

- A `customRun` step, or a templated command that allows `inProcess`, becomes a child session of the launching session, pinned to the step's major mode, minor modes, profile, domains, and model. The step's view in the workflow panel shows that session's live conversation where a command step shows its terminal. Each time the agent settles, the host first waits for its session to be idle, its message queue empty, and owned subagent/task/runner work (including pending runner completion handoffs) clear. This cancellable wait has no cap and consumes no decision reminders. Only then is the engine's gate asked: while the step still lacks its decision or declared artifacts, the agent is reminded, up to the gate's cap, and guidance sent from the web while it works is left to finish first. The step fails on a harness fault, on a session that cannot be opened (with the host's reason), and when a declared artifact was not written. Once the step ends, its session is released: it stops holding a model and tools but stays readable, as a dormant session, in the workflow's view.
- Every run keeps its engine log in `engine.log` in its run directory, which the artifacts pane lists, and a failed step records why in its progress entry. Engine errors, run starts, finishes, and failures also go to telemetry as `doom_workflow.*` events.
- Closing the session that launched a run asks the run to stop.
- `run` and `interactiveRun` steps each get their own RMUX pane, which the job's terminal view follows. Without a compatible RMUX binary, the step is spawned by the engine as before.

Every job must be the last to have written each run-directory entry it produces. After each step, workflow-mcp records in the run's `writes.ndjson` each declared entry that changed (new content, the same content written again, or removal) with the job and step that changed it. A job attempt fails, naming the entry and who wrote it last, unless this job is the latest writer of every entry it produces, and its retries apply. A retry, or a job that skips work it already did, keeps its own output; an entry another job wrote after it must be written again, so several jobs can produce one file and each is held to its own write. When an agent step ends the job, it is held to the entries it has yet to write before it stops, as it is to its own `artifacts` (which must also not be empty): the in-process runner asks the gate each time the agent settles, and a terminal agent is held the same way by its Stop hook (Claude Code and Codex) or the native `doompi-workflow` settled handler (Pi). Each reminder names the files and what the run directory says each holds, so give every entry a `description`. After the gate's cap (3 reminders by default, set with `WORKFLOW_DECISION_NUDGE_CAP`), the agent may stop, and the step or job fails with what is still missing. A job that ends with a script is only checked once it ends, since that script may still write its entries.

`runConfig` keys are validated: `majorMode`, `profile`, `model`, `thinking`, `subagentModel`, and `subagentThinking` take one name, while `minorModes` and `domains` take a list or a comma-separated string (an empty list selects no domains). An unknown key fails the step; on a templated step, a key the template of any command the step offers reads is known too.

Every in-process agent step must name `majorMode`. The workflow session a launch hands off to runs in the top-level `runConfig` selection plus the `workflow` minor mode, and a workflow without a top-level `majorMode` is refused before that session is created. A workflow sets the default once in its top-level `runConfig`, which workflow-mcp lays under the `runConfig` of every `interactiveRun` and `customRun` step (a key the step sets wins; imports merge it per key). A step with neither fails instead of running on the workspace default mode, whose tools, such as asking the user, would hang an unattended step:

```yaml
runConfig: { majorMode: dev }
```

Choices can configure the step and its Team children independently:

```yaml
choices:
  default:
    model: provider/step-model
    thinking: high
    subagentModel: provider/child-model
    subagentThinking: medium
```

Template choices support per-command overrides. `customRun` uses only the launch/default choice's subagent fields, without changing its existing step model/thinking behavior. Explicit child model requests outrank `subagentModel`, which outranks agent and Team defaults; unavailable models retain the existing fallback behavior. Thinking uses the selected explicit request's suffix first, then `subagentThinking`, the selected candidate's suffix, and agent defaults. Step model/thinking are never reused automatically. With neither subagent field present, existing Team behavior stays unchanged.

These preferences cover direct Team spawns from the step, including subagent runs and task assignments. External launchers must already support the corresponding model/thinking settings.

Check workflows before running them with `workflow-mcp doctor`, which reports what a run would otherwise only meet mid-step: schema and import problems, runConfig keys nothing reads, jobs that need a missing job, runner maps no runner satisfies, customRun steps without a terminal fallback, and inputs a workflow does not declare. Pass DoomPi's keys so runConfig typos are errors:

```bash
workflow-mcp doctor automations/workflows --run-config-keys majorMode,minorModes,profile,domains,model,thinking,subagentModel,subagentThinking
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

Pi terminal steps must load `doompi-workflow`; generic `hooks.yaml` does not enforce their decision gate. The native handler skips host-steered sessions and subagents and defers while owned background work or provider errors remain. `workflow-mcp` monitoring itself never blocks quietness.
