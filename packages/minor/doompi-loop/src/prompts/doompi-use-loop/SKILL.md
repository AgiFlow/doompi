---
name: doompi-use-loop
description: Use Doom Pi Loop to start, inspect, and stop session-scoped recurring prompts safely.
---

# Use Doom Pi Loop

Use Loop when the same prompt should run immediately and then recur while the current Pi session remains active.

## Start and control loops

1. Use `/loop` or `SPC l s` to start a loop.
2. Choose a prompt that is safe to repeat and an interval from 30 to 3600 seconds. The default is 300 seconds.
3. Use `/loops` or `SPC l l` to inspect active loops and stop individual instances.
4. Stop a loop as soon as its recurring work is complete.

Several loops can coexist. When Pi is busy, a due pass waits for the shared agent to become idle, and repeated due signals may coalesce instead of overlapping.

## Control cost and side effects

- Every pass can start another model turn and repeat tool calls or external side effects.
- Prefer idempotent checks and conservative intervals.
- Do not use Loop as a durable job queue. Replacing or shutting down the session stops timers, and resuming a transcript does not restart old loops.
- Stopping a loop prevents future passes, but it cannot undo effects from a prompt that was already sent.
