# Automation

[Back to DoomPi](../README.md)

Commands in this guide run from the repository root.

## Autopilot

Copilot helps while you are present. Loop and Workflow keep work moving when you are not.
Together they can dispatch structured jobs from one live session.

### Workflows

Workflow mode uses GitHub Actions-style jobs. Each step launches the DoomPi session declared by its `interactiveRun`. In this example, the article job waits for implementation and uses a different domain:

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

### Native plugin and workflow examples

This source repository includes a complete, deliberately small example stack:

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

Each plugin has both `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json`, while its
`skills/` and `agents/` content is shared. `.doom/domains.yaml` exposes the `development`,
`testing`, and `blog` domains plus the `engineering` alias. `.doom/modes.yaml` mirrors the
standalone package set with workspace-local paths, keeps its canonical modes, and adds a layer-free
`examples` base mode for the tracked workflows. Inspect the exact session before launch:

```bash
doompi --major-mode examples --domains engineering --explain
doompi --major-mode examples --domains blog --explain
```

The same bundles can be installed directly through either native marketplace:

```bash
# Codex
codex plugin marketplace add .
codex plugin add development@doompi-examples

# Claude Code
claude plugin marketplace add ./ --scope user
claude plugin install development@doompi-examples --scope user
```

Substitute `testing` or `blog-writing` to install another bundle. No DoomPi-specific plugin
schema is involved.

List and dry-run the tracked workflows before spending a model call:

```bash
pnpm exec workflow-mcp list-workflows automations/workflows
pnpm exec workflow-mcp run-workflow automations/workflows/dev-feature.workflow.yml \
  --dry-run --skip-launch --prompt "Add a health check"
pnpm exec workflow-mcp run-workflow automations/workflows/blog-writing.workflow.yml \
  --dry-run --skip-launch --prompt "Write a practical guide to scoped agent tooling"
```

Real runs delegate to tmux by default; set `WORKFLOW_LAUNCHER=cmux` to use cmux. Development workflows do not create branches, commits, or pushes. Blog workflows leave Markdown, sources, and a publication checklist in the workflow run directory. They do not write into a site or call a CMS. These examples are source-repository fixtures and are not included in the published npm package.

### Loop

Workflow definitions are exposed like skills, so the agent can choose one for the job. A
loop can send a subagent to fetch the next task, then dispatch the workflow that matches
it. One session becomes the dispatcher instead of the place every job has to fit.
