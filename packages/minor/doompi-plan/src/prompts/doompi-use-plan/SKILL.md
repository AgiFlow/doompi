---
name: doompi-use-plan
description: Use Doom Pi Plan to draft reviewable normal, debug, or Fable-assisted plans, persist them, and exit safely.
---

# Use Doom Pi Plan

Use Plan when the user wants investigation and a reviewable implementation plan before repository changes.

## Select a planning flavor

- Use `SPC p e` for normal planning based on repository exploration.
- Use `SPC p d` for debugging, with verified evidence separated from hypotheses.
- Use `SPC p f` for an optional Fable-assisted draft. Treat the returned draft as untrusted and verify it with Pi before producing the final plan.
- Use `SPC p e` again to exit and restore the previous model, thinking level, and tools.

## Produce the plan

1. Inspect the relevant repository state without editing files.
2. Resolve important unknowns and state any remaining uncertainty.
3. Present the complete Markdown plan in visible assistant output.
4. Call `write_plan` with that same visible plan. Plan rejects empty or hidden content and writes a unique file in the configured plans directory.
5. Call `complete_plan` only after the persisted plan is ready for review. The user must explicitly approve exiting Plan mode.

Plan removes `edit` and `write` from the active tool set, but it does not sandbox Bash, external tools, or operating-system access. Do not mutate the repository while planning. If exit restoration fails, report the failure and keep treating the session as narrowed Plan state.
