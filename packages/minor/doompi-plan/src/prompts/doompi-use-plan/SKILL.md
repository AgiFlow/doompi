---
name: doompi-use-plan
description: Use Doom Pi Plan to draft reviewable normal, debug, or Fable-assisted plans, persist them, and exit safely.
---

# Use Doom Pi Plan

Use Plan when the user wants investigation and a reviewable implementation plan before repository changes.

## Remote MCP workflow

Call `load_context` to inspect the bound session and its active minor modes.
Use the available inspection tools to investigate and present the complete plan
as visible Markdown. Separate verified facts from hypotheses.

When Plan mode is already active, call `write_plan` with that exact text in the
`markdown` argument. Use the returned path with `read` to verify the saved text.
The host file is not a downloadable ChatGPT attachment. Do not substitute local
transcript content or claim that saving authorizes implementation.

When Plan mode is inactive, present the plan in chat and explain that persistence
requires the user to activate Plan mode in DoomPi. Do not change modes through
Bash or a hidden interface to bypass that gate.

`complete_plan` requests approval in the local DoomPi UI, not in ChatGPT. Only use
it when the user intends to review there. An explicit instruction in chat does
not itself exit server Plan mode. Do not simulate approval or bypass mode gates.
During autonomous Voice, the headless UI-only `complete_plan` tool is unavailable.
Supply Markdown to `write_plan`; it will not open a UI input dialog in that mode.
Present the plan and wait for explicit user direction, never approve it yourself.
`run_fable_plan` is unavailable in the headless host. Plan using repository
inspection instead, without launching background subagents.

## Local DoomPi workflow

The local TUI uses `SPC p e` for normal planning, `SPC p d` for debugging, and
`SPC p f` for Fable where the host supports it. These are local shortcuts, not
remote tools. The local no-argument `write_plan` reads the visible plan from its
own session. `complete_plan` requires the user's explicit exit-or-continue choice.

Plan adds its own tools without removing other packages' tools. Availability is not permission to edit: do not mutate the repository while planning, except to save the plan through `write_plan`. If exit restoration fails, report the failure and continue planning without starting implementation.
