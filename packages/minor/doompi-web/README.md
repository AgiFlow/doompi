# @agimon-ai/doompi-web

Web cockpit for DoomPi: a multi-session hub that serves the browser console, discovers every
running [doompi-server](https://www.npmjs.com/package/@agimon-ai/doompi-server) through the session
registry, and multiplexes their authenticated sockets behind one page connection

This package is a composable [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) subsystem.
It registers no Pi extension and adds nothing to an interactive session.

## Enabling it

This package is still in development, so `doompi init` does not reference it and there is nothing
to add to `.doom/modes.yaml`. It is a standalone executable you run yourself, as shown under Run
below, or the process `doompi-server --web` starts for you.

## Requirements

- Node.js 22.19.0 or newer
- Running `doompi-server` processes registering their session sockets

## Install

```bash
npm install -g @agimon-ai/doompi-web
```

## Run

```bash
doompi-web
```

Then open `http://127.0.0.1:7433`. Bare `doompi-web` is the hub: it watches the session registry
(`~/.doompi/run` by default), attaches to every registered session, shows them all in the rail, and
can start new ones from the page. Pass `--socket` instead to pin the cockpit to exactly one
session, the pre-hub behavior.

| Flag                | Default         | Meaning                                          |
| ------------------- | --------------- | ------------------------------------------------ |
| `--registry-dir`    | `~/.doompi/run` | Registry to watch (also `DOOMPI_RUNTIME_DIR`)    |
| `--spawn-command`   | `doompi-server` | Command launching sessions created from the page |
| `--socket`          | off             | Fixed single-session mode: the socket to attach  |
| `--auth-token-file` | with `--socket` | File holding that socket's attach token          |
| `--port`            | `7433`          | HTTP port                                        |
| `--host`            | `127.0.0.1`     | Bind address                                     |
| `--assets`          | bundled         | Override the built SPA directory                 |

## Security

Attach tokens are read by this process from the token files the registry names and never reach the
browser. The server binds loopback by default, so reaching the cockpit already means having an
account on the machine. Remote access means tunnelling the port, for example over SSH; do not bind
a public address and call it done.

## What the cockpit shows

Everything comes from Pi's RPC protocol, so a bare Pi session and a DoomPi session both work and
neither is shown facts it did not report:

- **Sessions rail:** every registered session with its live status line, git branch, and working
  directory. Cards switch focus (digits `1`-`9` too), `ctrl+t` or the button creates a session in a
  directory you pick, and the hub launches a `doompi-server` there.
- **Timeline:** user prompts, streamed assistant text and reasoning, and tool calls from running to
  result, including failures. Scoped to the focused session; the others keep streaming into the
  hub's ring for when you switch.
- **Composer:** prompts while idle, steering while a run is in flight, queued follow-ups, and abort.
- **Status rail:** connection state with replay and drop counts, model, thinking level, context
  usage, cost, and session identity.
- **Dialogs:** the extension UI sub-protocol (`select`, `confirm`, `input`, `editor`), which is how
  a permission prompt reaches the browser. Cancelling answers the agent rather than stranding it.
- **Command palette:** `ctrl+k`, listing whatever `get_commands` reported and invoking it as a slash
  prompt. A DoomPi session therefore offers `/mode`, `/domains` and `/profile` here.

## Attach and reattach

The hub, not the page, holds each session: it is the one client `doompi-server` allows, and every
browser tab multiplexes behind it, so two tabs on one session work. Losing the browser changes
nothing for the agent; the hub keeps a bounded ring of each session's frames and replays it when a
page subscribes, reporting how many frames the ring had to drop. If another client holds a socket,
the rail says so and the hub keeps retrying with backoff until it can take over. A page cannot
perform the handshake itself: `attach` frames sent from the browser are refused.

## Current limits

- One agent per `doompi-server` process; the hub presents many such servers as one working set.
- The four DoomPi selection axes (profile, major mode, domains, minor modes) are not exposed over
  Pi RPC, so the rail does not display them. The palette can still invoke the commands that change
  them.
- Subagent, workflow, and runner surfaces report summaries only; per-run detail has no RPC source
  to render from yet.

## Public API

```ts
import { serveWeb } from '@agimon-ai/doompi-web';
```

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm lint
pnpm exec vibe-lint check .
npm pack --dry-run
```

`pnpm test:e2e` drives the built executable in a real browser against a scripted session socket, so
run `pnpm build` first.

Maintained by [Agimon](https://agimon.ai/about).

## Web plugins

Tabs beyond the conversation are plugins. A package declares a `doompiWeb` block in its
package.json naming a client entry (a `webPlugin` definition: tab, panel, badge, session data
channels, and other slot contributions) and an optional hub entry (`webHubChannels`: data sources
the hub runs server-side). The build scans the workspace, generates the registration modules and
the Tailwind source list, and compiles every client entry into the one bundle; CI fails on a stale
registry, so regenerate with `pnpm build` and commit the generated files with a manifest change.
The hub imports external hub entries lazily: a missing plugin package logs a notice and its tab
shows an empty state. The subagents tab is the in-package reference plugin; the workflows tab lives
in `@agimon-ai/doompi-workflow`. Contracts come from `@agimon-ai/doompi-web-contracts`.

## License

Source available under the DoomPi Web License (see LICENSE). Use is free for any purpose, including
production and commercial use, and you may modify it and publish patches. Redistributing the
software, or offering it to third parties as a hosted or managed service, is not permitted.
