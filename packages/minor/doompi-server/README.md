# @agimon-ai/doompi-server

Headless DoomPi session server: supervises a Pi RPC agent behind an authenticated unix socket so clients can attach and reattach

This package is a composable [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) subsystem.
It is the serving core the web, desktop, and mobile clients attach to. It registers no Pi
extension and adds nothing to an interactive session.

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
the same agent. Losing the client does not end the run. Frames buffer while nobody is attached and
replay on the next attach, so a dropped connection or a reloaded page recovers instead of losing
the session. The buffer is bounded and reports how many frames it had to drop.

## Current limits

- The executable itself is not covered end to end; the supervisor, socket, handshake, and replay
  paths are.
- Transport is a unix socket only. Remote access means tunnelling it, for example over SSH.
- One agent per server process. Serving several sessions means several servers.

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
