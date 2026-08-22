# @agimon-ai/doompi-notification

Desktop notifications and an animated shell-tab title for
[DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) sessions.

Long agent runs are worth walking away from. This package makes that safe: the terminal tab says
what the session is doing at a glance, and the desktop says when the agent has stopped and why.

## What it does

| Surface          | Behavior                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Shell tab title  | `π - <session or first prompt> - <repository>`, with a braille spinner while the agent works |
| Desktop, mid-run | one notification for each agent-initiated dialog and each `ask_user_question` prompt         |
| Desktop, at rest | one notification when a run settles with nothing queued behind it                            |

Notifications go to `cmux notify` first, because it routes them back to the window the session
lives in. On macOS a missing `cmux` falls back to `osascript`. Any other host stays silent rather
than failing the turn.

## The shell title

The title is animated from a worker thread, so a busy agent turn never stalls the spinner. The
worker is unreferenced, so a pending frame cannot hold the process open. If worker threads are
unavailable, or the worker fails or exits, the last command replays on the main thread.

Titles are only written to an attached terminal: `rpc` sessions and headless ones get none, so
escape sequences never end up in machine-read output.

## Quiet by design

- A detached subagent (`PI_SUBAGENT_CHILD`) registers nothing. It shares its parent's terminal and
  desktop, and a second voice reporting the same run is noise.
- Dialogs only notify while the agent holds the turn. A dialog the user opened is already in front
  of them.
- An `ask_user_question` prompt notifies from its own event, and the dialog it then opens stays
  silent, so one question is announced once.
- A settled run with pending follow-up messages notifies nothing: the agent is about to keep going.

## Installation

DoomPi depends on this package and activates it as fixed host core, so a DoomPi install already has
it. It is not selectable from `.doom/modes.yaml`.

## License

MIT
