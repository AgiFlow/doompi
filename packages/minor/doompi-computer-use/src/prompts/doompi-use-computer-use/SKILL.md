---
name: doompi-use-computer-use
description: 'Safely use session-scoped semantic computer control through DoomPi Desktop.'
---

# Use Computer Use

This guidance applies only while the session's Computer Use minor mode is active.

## Guidance

- Call `computer_state` before acting and after an action that may change the interface.
- Use only snapshot ids and element refs returned by the latest `computer_state` result.
- Call `computer_action` for one semantic `press`, `set_value`, or `scroll` at a time.
- Never infer screen coordinates, inspect another application, or bypass secure elements.
- Treat stale snapshots, lost targets, and uncertain outcomes as terminal until a fresh observation clarifies them.
- Do not automatically retry an uncertain action.
- Stop Computer Use when the requested task is complete.

Activation is session scoped. Select a Desktop target, request activation, and wait for explicit confirmation in the Computer Use cockpit panel. Another session may own the single Desktop run, in which case this session remains inactive and reports which session is busy.
