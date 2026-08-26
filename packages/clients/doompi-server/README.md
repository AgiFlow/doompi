# @agimon-ai/doompi-server

Headless DoomPi session server: supervises a Pi RPC agent behind an authenticated unix socket so clients can attach and reattach

This package is a composable [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) subsystem.
It is the serving core the web, desktop, and mobile clients attach to. It registers no Pi
extension and adds nothing to an interactive session.

## Enabling it

This package is still in development, so `doompi init` does not reference it and there is nothing
to add to `.doom/modes.yaml`: it registers no Pi extension and is not part of a mode. It is a
standalone executable you run yourself, as shown under Run below.

## Requirements

- Node.js 22.19.0 or newer
- `@agimon-ai/doompi` on PATH, which the server supervises

## Install

```bash
npm install -g @agimon-ai/doompi-server
```

## Run

```bash
printf '%s' "$(openssl rand -base64 32)" > /run/doompi/token
chmod 600 /run/doompi/token

doompi-server --listen /run/doompi/session.sock --auth-token-file /run/doompi/token -- --major-mode copilot
```

The server starts `doompi --mode rpc` with the arguments after `--`, then publishes that session
on the socket. The socket is created owner-only, under a umask so the mode is atomic rather than
applied after the fact.

The session gets an identity at spawn: the server mints a session id (or takes `--session-id`) and
passes it to Pi together with the `--name` you gave it, so the cockpit knows the session before its
first frame.

The agent binary resolves per working directory: a repository that pins its own
`@agimon-ai/doompi` in node_modules runs that exact version (mirroring how launcher scripts
resolve the repo-local CLI), `DOOMPI_AGENT_COMMAND` overrides the lookup with a binary or a
`.mjs` path, and the `doompi` on PATH is the fallback.

## Major-mode relaunches

A launcher-class session cannot recompose its extension closure in place, so switching to a major
mode with a different layer set normally stays pending until someone reruns the launcher. This
server performs that relaunch itself: the runtime journals the switch, writes a relaunch file the
server points it at, and the server ends the agent's input for a graceful exit, then respawns it
with the new `--major-mode` under the same session id and socket. Clients stay attached; the
replacement resumes the same Pi session and acknowledges the journaled transition. An agent that
ignores the request is killed after a grace period, and an exit without the file ends the session
as before.

## The session registry

Every server announces itself by writing one JSON record to
`~/.doompi/run/sessions/<session id>.json` (override the directory with `--registry-dir` or
`DOOMPI_RUNTIME_DIR`). The record names the socket, the working directory, the token file, and the
server pid; writing it is the whole act of registration, and the server withdraws it on exit. The
web cockpit watches this directory to find every running session, and deletes records whose pid is
gone, so a crashed server does not haunt the rail.

## Serving the web cockpit

Add `--web` to make sure a browser cockpit is reachable:

```bash
doompi-server --listen /run/doompi/session.sock --auth-token-file /run/doompi/token --name doompi-web --web 7433 -- --major-mode copilot
```

The port is optional and defaults to 7433. The cockpit is a multi-session hub: if one already
answers on the port, this server just logs its URL and appears there through the registry; only
otherwise does it start the hub in-process. An embedded hub dies with its server, so for several
sessions the durable topology is a standalone `doompi-web`. The cockpit binds loopback and reads
tokens from token files, so the browser never holds a session credential. `--web` requires
[@agimon-ai/doompi-web](https://www.npmjs.com/package/@agimon-ai/doompi-web), which is an optional
peer: without it the flag reports what to install rather than failing obscurely.

## Protocol

Newline-delimited JSON in both directions, carrying Pi's own RPC frames untouched. The server adds
only a handshake:

| Frame                                          | Direction        | Meaning                                        |
| ---------------------------------------------- | ---------------- | ---------------------------------------------- |
| `{"type":"attach","token":"..."}`              | client to server | Must be the first frame                        |
| `{"type":"attached","replayed":N,"dropped":M}` | server to client | Accepted, with what the client missed          |
| `{"type":"attach_error","reason":"..."}`       | server to client | Refused, and the connection closes             |
| `{"type":"replay","frame":{...}}`              | server to client | One frame emitted while no client was attached |

Everything else passes through: client frames go to the agent, agent frames go to the client.

## Attach and reattach

One client holds a session at a time; a second attach is refused rather than allowed to fight over
the same agent. When the web cockpit runs, the hub is that one client and browser tabs multiplex
behind it. Losing the client does not end the run. Frames buffer while nobody is attached and
replay on the next attach, so a dropped connection or a reloaded page recovers instead of losing
the session. The buffer is bounded and reports how many frames it had to drop.

## Current limits

- The executable itself is not covered end to end; the supervisor, socket, handshake, and replay
  paths are.
- Transport is a unix socket only. Remote access means tunnelling it, for example over SSH.
- One agent per server process. Serving several sessions means several servers, which the registry
  and the cockpit hub present as one working set.

## Public API

```ts
import { serveSessionSocket, spawnAgentProcess } from '@agimon-ai/doompi-server';
```

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm exec vibe-lint check .
npm pack --dry-run
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
