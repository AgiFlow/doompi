---
name: doompi-use-goal
description: Use Doom Pi Goal to start, budget, pause, resume, complete, block, and inspect persistent repository goals.
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

Call `goal_complete` only when authoritative evidence proves the objective is genuinely achieved and no required work remains. A prose claim, passing test, created file, or ordinary agent turn does not complete the Goal. If any requirement remains, continue concrete work. Pending subagents, tasks, runners, and workflows are work in progress, so wait for and incorporate their results before completion.

Call `goal_blocked` only when the runtime's repeated-blocker threshold is met and progress requires user input or an external state change. Keep the active goal identifier and final summary consistent with the current goal.

Goal state persists in Pi session entries, while history is scoped to the repository. Completed, cleared, or blocked goals no longer contribute active instructions or tools. A session holds one goal at a time; starting another replaces and archives the one being worked.
