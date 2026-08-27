# @agimon-ai/doompi-server

Headless DoomPi session server. It supervises a Pi RPC agent behind an authenticated Unix socket so clients can attach and reattach.

This package is a composable [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) subsystem.
It is the serving core the web, desktop, and mobile clients attach to. It registers no Pi
extension and adds nothing to an interactive session.

## How it runs

`doompi-server` is a standalone process, not a Pi extension. Do not add it to `.doom/modes.yaml`. `doompi init` does not configure it.

## Requirements

- Node.js 22.19.0 or newer
- A runnable DoomPi agent. The server checks the working directory's installation, `DOOMPI_AGENT_COMMAND`, then `doompi` on `PATH`.

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

The server starts `doompi --mode rpc` with the arguments after `--`, then publishes the session on the socket. It creates the socket with owner-only access under a restrictive umask.

The session gets an identity at spawn: the server mints a session id (or takes `--session-id`) and
passes it to Pi together with the `--name` you gave it, so the cockpit knows the session before its
first frame.

The agent command resolves for each working directory. A repository-local `@agimon-ai/doompi` takes precedence, `DOOMPI_AGENT_COMMAND` can name a binary or `.mjs` file, and `doompi` on `PATH` is the fallback.

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

- The executable itself is not covered end to end. Tests cover the supervisor, socket, handshake, and replay paths.
- Transport uses a Unix socket only. Tunnel it, for example over SSH, for remote access.
- Each server process runs one agent. Run several servers for several sessions; the registry and cockpit hub present them as one set.

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
