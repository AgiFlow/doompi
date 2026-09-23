---
name: doompi-use-goal
description: Use Doom Pi Goal to start, budget, pause, resume, and inspect persistent repository goals with automatic completion checking.
---

# Use Doom Pi Goal

Use Goal when work must persist across turns with an explicit objective, optional token budget, and auditable terminal status.

## Manage the objective

- Start with `/goal <objective>` or `/goal --tokens 100k <objective>`.
- Inspect the current objective with `/goal status` or `SPC g g`.
- Use `/goal pause` and `/goal resume` when work should stop and continue without losing the objective.
- Use `/goal edit [--tokens <budget>] <objective>` when the objective or budget changes.
- Use `/goal clear` only when the active objective should be removed without being completed.
- In a TUI, `SPC g e` starts a goal and ends and archives the one being worked, and `SPC g l` inspects repository history.

## Finish accurately

Perform the work and leave concrete verification evidence. A prose claim, passing unrelated test, created file, or ordinary agent turn does not complete the Goal. Pending subagents, tasks, runners, workflows, and undelivered results are still work in progress. Incorporate their results before concluding the work.

An independent LLM checker runs only after the main agent and all registered background work have settled, with no pending messages. It calls private lifecycle tools to complete the goal, give the working agent a concrete next action, or retain a genuine repeated external blocker. Those tools are not available to the working agent. Report blockers and the intervention needed in the normal work transcript; do not invent a lifecycle tool call.

A successful completion check archives the evidence and removes the active goal. Pause, cancellation, budgets, and safety limits override continuation. A failed check or failed archive retains the goal and reports the problem; resolve it and use `/goal resume` when appropriate.

Goal state and checker decisions persist in session entries, while history is scoped to the repository. Completed, cleared, or blocked goals no longer contribute active work instructions. A session holds one goal at a time; starting another requires confirmation before replacing and archiving the current goal.
