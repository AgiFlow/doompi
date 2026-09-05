# @agimon-ai/doompi-autostop

Shuts a [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) session down once the agent
settles and stays idle.

A scripted run wants the session to exit on its own when the work is done. Waiting for
`agent_settled` alone is not enough: the agent can settle and immediately pick up a queued
message, and it can settle while the last response is still streaming. So this package settles,
waits, looks again, and only then stops.

## The policy

| Moment             | Session state     | Outcome              |
| ------------------ | ----------------- | -------------------- |
| `agent_settled`    | messages queued   | stand down           |
| `agent_settled`    | queue empty       | look again in 5s     |
| the scheduled look | messages queued   | stand down           |
| the scheduled look | still streaming   | look again in 100ms  |
| the scheduled look | idle, queue empty | `context.shutdown()` |

Any `input` or `agent_start` event disarms a pending stop. The cooldown is the grace period;
the 100 ms recheck waits out a stream that has not finished draining.

`decideOnSettled` and `decideOnRecheck` are the whole policy and take the session state as a
plain value, so the timing rules are testable without a Pi host.

## What it registers

| Entry             | Surface                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `./extensions/pi` | `input`, `agent_start` and `agent_settled` hooks, plus the shutdown that disarms them |

The extension owns a Cordis fiber; `session_shutdown` disposes it, which cancels any armed stop.
That matters because Pi reloads extensions in process. A timer left armed by the previous load
would stop the session it was reloaded into.

## Installation

DoomPi depends on this package and activates it when a run asks for `--auto-stop`. It is not
selectable from `.doom/modes.yaml`.

## License

MIT
