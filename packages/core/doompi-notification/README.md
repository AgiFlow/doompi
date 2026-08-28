# @agimon-ai/doompi-notification

System and browser notifications, plus an animated shell-tab title, for
[DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) sessions.

Long agent runs are worth walking away from. This package owns the shared `doom/notification` service,
routes each request for the active session, and announces when the agent needs attention.

## What it does

| Surface          | Behavior                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Shell tab title  | `π - <session or first prompt> - <repository>`, with a braille spinner while the agent works |
| Notification API | caller-authored notices through the shared `doom/notification` Cordis service                |
| Mid-run          | one notification for each agent-initiated dialog and each `ask_user_question` prompt         |
| At rest          | one notification when a run settles with nothing queued behind it                            |

In an interactive terminal session, requests use `cmux notify` first because it routes them back to
the session window. On macOS, a missing `cmux` falls back to `osascript`. In RPC mode, requests become
versioned `doom-notification` session entries for a live client such as `doompi-web`. An RPC append
failure stays silent and never falls back to a host notifier. Hosts without a supported notifier also
stay silent.

## Service usage

Callers should discover the optional service through Cordis and request delivery without depending on
a particular host:

```ts
import {
  DOOM_NOTIFICATION_SERVICE,
  readDoomNotificationService,
} from '@agimon-ai/doompi-extension-contracts/notification';

ctx.inject([DOOM_NOTIFICATION_SERVICE], (notificationContext) => {
  void readDoomNotificationService(notificationContext)?.request({
    body: 'Deployment needs approval',
    level: 'warning',
  });
});
```

`body` is required. `title`, `subtitle`, and `level` are optional, and `level` accepts `info`,
`warning`, or `error`. The router defaults the title to `Pi`, the subtitle to the session name or
working-directory basename, and the level to `info`. Invalid requests, missing active sessions,
unavailable providers, and delivery failures are silent so notifications cannot fail an agent turn.

The package also wraps Pi's broad `ui.notify(message, level)` API while active, so existing extensions
use the same route without changing their calls. If this package is muted or the process is a detached
subagent child, it does not install that wrapper and Pi's original `ui.notify` behavior remains.

## Browser delivery

`doompi-web` shows only entries received by a currently open page. Every connected page receives live
notification entries for every attached session, not only the focused session. Permission is requested
only when the user clicks **allow notifications** in web settings. There is no service worker, Web Push,
replay, or durable notification queue, so a closed or disconnected page receives nothing later.

## The shell title

The title is animated from a worker thread, so a busy agent turn never stalls the spinner. The
worker is unreferenced, so a pending frame cannot hold the process open. If worker threads are
unavailable, or the worker fails or exits, the last command replays on the main thread.

Titles are only written to an attached terminal: `rpc` sessions and headless ones get none, so
escape sequences never end up in machine-read output.

## Quiet by design

- A detached subagent (`PI_SUBAGENT_CHILD`) does not register this package's service or wrappers. It
  shares its parent's terminal and desktop, and a second voice reporting the same run is noise.
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
