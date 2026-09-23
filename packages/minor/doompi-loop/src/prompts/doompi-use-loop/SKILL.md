---
name: doompi-use-loop
description: Create, inspect, and stop session-scoped interval, cron, and extension-contributed loops.
---

# Use Doom Pi Loop

Enable the Loop minor mode to expose `loop_list`, `loop_start`, and `loop_stop` to the agent. Enabling the mode does not create a loop. Disabling it hides agent tools but leaves existing loops and manual Activity controls available.

## Agent configuration

Call `loop_list` first. It returns the available launcher IDs, their input schemas, and active instance IDs. Providers without an input schema require manual setup and cannot be started by an agent tool.

An interval loop runs immediately when the session can accept a prompt, then every 30 to 3600 seconds:

```json
{
  "launcherId": "doompi.default",
  "input": { "prompt": "Check the current build status and report changes.", "intervalSeconds": 300 }
}
```

A cron loop runs at its next scheduled minute, not immediately. Supply a five-field cron expression and an optional IANA timezone. The default timezone is UTC:

```json
{
  "launcherId": "doompi.cron",
  "input": { "prompt": "Summarize the work remaining today.", "cron": "0 9 * * 1-5", "timezone": "Australia/Brisbane" }
}
```

Pass either configuration to `loop_start`. Stop one instance with `loop_stop` and its exact `instanceId`. Extension launchers, such as Agiflow project dispatch, use their own schemas from `loop_list`; do not guess their configuration fields.

## Manual controls

Activity's Loops group is available whenever the Loop package is loaded, even with the minor mode off. It offers interval and cron setup, a chooser for extension types, and per-instance stop controls. `/loop [launcherId]` starts manual setup. `/loops` lists instances, and `/loops stop <instanceId>` stops one. The TUI also provides `SPC l s` and `SPC l l`.

## Cost and lifecycle

Several loops can coexist, but built-in loops do not deliberately overlap prompts on the same agent. The CLI coalesces due passes while busy and retries after the agent settles. The server skips busy ticks and checks again at the next scheduled tick.

Every pass can start a model turn and repeat tool calls or external side effects. Prefer idempotent checks and conservative schedules. Stop loops when the recurring work is complete.

Loops are session-scoped, not a durable job queue. Replacing or shutting down the session stops timers; reopening a transcript does not restart them or replay missed ticks. Stopping prevents future submissions but does not undo or cancel a prompt already submitted.
