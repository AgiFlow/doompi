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

For an agent step, declare the command once under `commands` (usually in an imported file) and let the step name it. A command is a Liquid template; `inProcess: true` lets the DoomPi server run it as a child session instead of the shell, and the CLI and the TUI run the rendered command:

```yaml
imports: [commands.yml]
choices:
  default: { model: openai-codex/gpt-6-sol, thinking: medium }
jobs:
  develop:
    steps:
      - name: Develop
        runConfig: { majorMode: dev, domains: [engineering] }
        systemPrompt: ${{ env.JOB_SYSTEM_PROMPT }}
        prompt: ${{ env.WORKFLOW_CONTEXT }}
        interactiveRun: [{ command: doompi }, { command: terminal }]
```

`doompi` and `terminal` are the commands `commands.yml` declares; a step can only name a declared command. `runConfig` takes `majorMode`, `minorModes`, `profile`, `domains`, `model`, and `thinking`, plus any key the template reads; any other key fails the step, so a typo such as `majormode` never runs on workspace defaults. `choices` compose model and thinking, with per-command overrides such as `terminal: { model: openai-codex/gpt-6-luna }`; a step can pin `choice:`, and a launch picks `command=` and `choice=` for the rest. Templates must quote prompts with `{{ prompt | shell }}`.

Before committing a workflow, run `workflow-mcp doctor <file-or-directory> --run-config-keys majorMode,minorModes,profile,domains,model,thinking` and fix every error it reports; the DoomPi server refuses to launch a workflow with errors.

An agent step ends by recording its outcome: `workflow-mcp step complete`, `step fix --restart-from <job> --reason ...`, or `step fail --reason ...`. The engine puts the instructions in the step's system prompt, and an agent that stops without deciding is sent back until it does. Write repair contracts in those terms, not as `fix.md`.

Put independent checks in a `parallel` group. A `run:` check with `restart-from: <job>` turns a failure into a fix request, and every fix request of the job merges into one repair, so one loop back fixes all of them. Keep steps that edit files out of a group: its steps share the checkout.

Every `run` command executes on the workflow host with that process's environment and privileges. There is no VM, container, or sandbox. Review workflow changes as executable code, avoid embedding secrets, and make retry-sensitive external side effects explicit.

Before relying on the graph, enable Workflow mode, discover it with `list_workflows`, launch a disposable run, and inspect job and step status with `workflow_run`. Test a failure path when recovery behavior matters.
