# Automation

[Back to DoomPi](../README.md)

DoomPi has two automation levels:

```text
Loop      repeats a prompt inside one live session
Workflow  runs a dependency graph with a separate DoomPi session per step
```

Use Loop when state should stay in one conversation. Use Workflow when jobs need explicit dependencies, timeouts, artifacts, or different compositions. A loop can act as a dispatcher that chooses and launches workflows.

Commands in this guide run from the repository root.

## Workflow execution model

Workflow mode reads GitHub Actions-style job graphs. `needs` creates dependencies between jobs. Each `interactiveRun` starts the DoomPi command written by the workflow, so the definition owns the mode, domains, working directory, and other launch policy for that step.

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
        interactiveRun:
          default: |
            doompi --major-mode examples --domains development --auto-stop \
              --cwd "$PWD" "$JOB_SYSTEM_PROMPT"

  article:
    needs: implement
    steps:
      - name: Write the article
        timeout-minutes: 30
        interactiveRun:
          default: |
            doompi --major-mode examples --domains blog --auto-stop \
              --cwd "$PWD" "$JOB_SYSTEM_PROMPT"
```

`--auto-stop` closes an interactive automation session after its agent settles. Timeouts remain workflow policy and should reflect the cost and expected duration of each job.

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

The same plugins can be installed through their native marketplaces. DoomPi adds no private plugin schema:

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

Real runs use tmux by default. Set `WORKFLOW_LAUNCHER=cmux` to use cmux. The tracked development workflows do not create branches, commits, or pushes. Blog workflows write Markdown, sources, and a publication checklist into the workflow run directory. They do not publish to a site or CMS.

These examples are repository fixtures and are not included in the published npm package.

## Loop as a dispatcher

Loop mode runs a prompt immediately and repeats it on an interval inside the current session. Workflow definitions are exposed like skills, so a loop can ask a subagent for the next task and dispatch the matching workflow.

That keeps scheduling and routing in one live session while each unit of work gets a fresh, explicit composition. Do not use Loop when the work needs durable job dependencies or isolated artifacts; that is Workflow's boundary.

See [Features](features.md#modes-and-automation) for the user-facing controls and [Configuration](configuration.md) for selecting the packages that provide them.
