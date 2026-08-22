---
name: doompi-use-workflow
description: Use DoomPi workflows. Use when discovering or launching workflows, monitoring or controlling asynchronous runs, interpreting terminal notifications, or recovering a failed run safely.
---

# Use DoomPi workflows

Enable model-visible Workflow tools with `SPC w e`. In a non-interactive harness, set `WORKFLOW_MCP_MODE=on` before starting the session.

Use the tools in this order:

1. `list_workflows` discovers available workflow definitions.
2. `launch_workflow` registers and starts a run. A successful launch response does not mean the jobs have finished.
3. `workflow_run` inspects status, follows progress, or applies a supported control action.
4. Wait for a terminal notification and verify the final job and step states before reporting success.

In the TUI, `SPC w l` lists the repository's workflows and launches the one under the cursor with `r`, `SPC w r` inspects this session's runs, and `SPC w c` opens recovery. The root session can launch. Child sessions can inspect the catalog but do not receive an unrestricted workflow factory.

Recover only a record already in a terminal failure state. Inspect its evidence first, then use the package's `workflow-recovery` runtime skill for the repair workflow. Recovery atomically adopts eligible work, but it cannot make non-idempotent external side effects safe or guarantee that in-process work survives parent shutdown.

Workflow steps and model-backed repair can consume provider quota and repeat external effects. Do not relaunch or replay a run merely because progress is quiet. Inspect live ownership and persisted state first.
