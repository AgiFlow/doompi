---
name: doompi-author-workflow
description: Author DoomPi workflow definitions. Use when creating or changing a *.workflow.yml graph, arranging job dependencies and host-executed steps, or deciding how a command requiring a TTY should run.
---

# Author DoomPi workflows

Create a `*.workflow.yml` file and keep its graph explicit:

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

`needs` expresses job ordering. Keep steps small enough that failure evidence identifies the command that needs attention. Use runner-specific `interactiveRun` configuration when a command genuinely requires a TTY.

Every `run` command executes on the workflow host with that process's environment and privileges. There is no VM, container, or sandbox. Review workflow changes as executable code, avoid embedding secrets, and make retry-sensitive external side effects explicit.

Before relying on the graph, enable Workflow mode, discover it with `list_workflows`, launch a disposable run, and inspect job and step status with `workflow_run`. Test a failure path when recovery behavior matters.
