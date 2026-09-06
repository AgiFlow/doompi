# @agimon-ai/doompi-server

**A headless server for one DoomPi session.**

`doompi-server` owns a Pi RPC agent and exposes it through an authenticated Unix socket. A client can
attach, disconnect, and reattach while the agent keeps running. The server also publishes Pi's routed
session protocol, optional session package APIs, and a registry record for the web cockpit.

This is a standalone process, not a Pi extension. Do not add it to `.doom/modes.yaml`; `doompi init`
does not configure it.

## Contents

| Guide                          | What it covers                                                      |
| ------------------------------ | ------------------------------------------------------------------- |
| [Lifecycle](docs/lifecycle.md) | Startup, agent selection, relaunches, registry, and shutdown        |
| [IPC](docs/ipc.md)             | Unix sockets, framing, attach and replay, and the Pi protocol       |
| [API](docs/api.md)             | Session package APIs and the TypeScript export surface              |
| [Security](docs/security.md)   | Filesystem permissions, tokens, trust boundaries, and remote access |

## Requirements

- Node.js 22.19.0 or newer
- A DoomPi installation in the session repository, `DOOMPI_AGENT_COMMAND`, or the installed DoomPi package

## Install

```bash
npm install -g @agimon-ai/doompi-server
```

## Quick start

Create a private runtime directory and token, then pass the agent arguments after `--`:

```bash
runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/doompi-session.XXXXXX")"
(umask 077; openssl rand -base64 32 > "$runtime_dir/token")

doompi-server \
  --listen "$runtime_dir/session.sock" \
  --auth-token-file "$runtime_dir/token" \
  -- --major-mode copilot
```

The token is read from the file, not from the command line. Keep the runtime directory private. The
server appends `--mode rpc` to the agent invocation and waits for the agent to exit.

To serve the browser cockpit from the same process, install the optional web package and add `--web`:

```bash
npm install -g @agimon-ai/doompi-web
doompi-server \
  --listen "$runtime_dir/session.sock" \
  --auth-token-file "$runtime_dir/token" \
  --name doompi-web \
  --web \
  -- --major-mode copilot
```

`--web` uses port `7433` by default. If a DoomPi cockpit already answers there, this server registers
its session with that hub instead of starting another one. A standalone `doompi-web` process is the
durable choice for several sessions.

## How it works

The server resolves the session identity, composes or delegates the configured DoomPi installation,
and starts one agent in RPC mode. It binds the session socket at `--listen`, the Pi protocol socket at
`<listen>.pi`, and a package API socket at `api.sock` beside the session socket when session APIs are
available. Only after these services are ready does it write the session record.

A session has one supervised agent and one client on the framed session socket. Frames pass through
unchanged after the attach handshake. If the client disconnects, the agent continues and a bounded
backlog is replayed on the next attach. The [IPC guide](docs/ipc.md) describes the wire contracts.

A major-mode change that needs a new extension composition is handled as a relaunch. The server keeps
the session id, sockets, and registry record while it asks the current agent to exit cleanly and starts
the replacement. See the [lifecycle guide](docs/lifecycle.md) for the state transitions.

## Command line

| Option                     | Default               | Meaning                                           |
| -------------------------- | --------------------- | ------------------------------------------------- |
| `--listen <path>`          | required              | Unix socket for the framed session transport      |
| `--auth-token-file <path>` | required              | File containing the attach token                  |
| `--name <name>`            | `untitled`            | Name shown by clients and written to the registry |
| `--session-id <id>`        | generated UUID        | Session id; it must not contain `/`               |
| `--registry-dir <path>`    | `~/.doompi/run`       | Parent of the session registry                    |
| `--web [port]`             | no cockpit, or `7433` | Start or join the browser cockpit                 |
| `-- <agent arguments>`     | none                  | Arguments passed to the DoomPi agent              |

Options before `--` belong to `doompi-server`. Everything after it belongs to the agent. If agent
arguments already contain `--session-id` or `--name`, those values are used for the session identity.

The registry directory can also be set with `DOOMPI_RUNTIME_DIR`. Agent selection uses
`DOOMPI_AGENT_COMMAND` when the repository does not pin a different DoomPi launcher. `DOOMPI_API_DIR`
can point the server at a generated session API directory. `DOOMPI_WEB_MODULE` selects the web module
used by `--web`.

## Registry

Each running server writes one owner-only JSON record at
`<registry-dir>/sessions/<session id>.json`. It contains the session id and name, working directory,
socket paths, server pid, and creation time. It stores the token file path, never the token itself.
The web cockpit watches these records and treats a dead pid as stale. The [security guide](docs/security.md)
explains why the directory and its paths must remain private.

## Public API

The package exports the socket servers, agent process adapter, Pi session service, transcript projection,
and framing helpers:

```ts
import {
  createAgentServerService,
  serveProtocolSocket,
  serveSessionSocket,
  spawnAgentProcess,
} from '@agimon-ai/doompi-server';
```

Use the [API guide](docs/api.md) for the session package API and the complete export roles.

## Limits

- One `doompi-server` process supervises one agent.
- The framed Unix socket allows one attached client at a time.
- The server's transports are Unix sockets, not network listeners. Use a trusted tunnel or the web
  cockpit for remote access.
- The executable path is covered by component and integration tests, but not by an end-to-end test of
  every installed-package combination.

## Development

Run from this package directory:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
