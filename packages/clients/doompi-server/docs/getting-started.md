# Getting started

`doompi-server` is the process boundary for one headless DoomPi session. It starts the agent, keeps it alive when a client disconnects, and publishes local endpoints that a terminal client or DoomPi Web can attach to.

## Choose the topology

Use the server directly when you are building a local client or need one durable headless session:

```text
client -> authenticated Unix socket -> doompi-server -> Pi RPC agent
```

Add DoomPi Web when a browser should control the session:

```text
browser -> DoomPi Web hub -> authenticated Unix socket -> doompi-server -> agent
```

The hub, not the browser, reads the session token. For several sessions, run one standalone `doompi-web` hub and let it discover multiple server records.

## Requirements

- Node.js 22.19.0 or newer
- A DoomPi installation in the session repository, `DOOMPI_AGENT_COMMAND`, or the installed DoomPi package

Install the published server:

```bash
npm install -g @agimon-ai/doompi-server
```

## Start a session

Create both the socket and token under a private directory:

```bash
runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/doompi-session.XXXXXX")"
(umask 077; openssl rand -base64 32 > "$runtime_dir/token")

doompi-server \
  --listen "$runtime_dir/session.sock" \
  --auth-token-file "$runtime_dir/token" \
  --name work \
  -- --major-mode copilot
```

Server options appear before `--`. Everything after it is passed to DoomPi. The server appends `--mode rpc`, starts the selected agent, and waits for that child to exit.

The token is a session-control capability. It is read from the file so it does not appear in the server's argument list. The server refuses an empty token but does not create or protect the file for you. Keep the runtime directory private.

## What startup creates

A ready session owns:

| Resource          | Purpose                                                   |
| ----------------- | --------------------------------------------------------- |
| `session.sock`    | Token-protected raw Pi RPC attachment                     |
| `session.sock.pi` | Pi routed state and command protocol                      |
| `api.sock`        | Optional HTTP routes from session packages                |
| Registry record   | Discovery metadata for DoomPi Web and other local clients |

The registry record is written only after the agent and transports are ready. It contains paths to these resources and the token file, not the token value. See [Lifecycle](lifecycle.md) for startup ordering and [IPC](ipc.md) for the wire contracts.

## Command options

| Option                     | Default             | Meaning                                          |
| -------------------------- | ------------------- | ------------------------------------------------ |
| `--listen <path>`          | required            | Unix socket for the framed session transport     |
| `--auth-token-file <path>` | required            | File containing the attach token                 |
| `--name <name>`            | `untitled`          | Name shown by clients and stored in the registry |
| `--session-id <id>`        | generated UUID      | Stable session identity; it must not contain `/` |
| `--registry-dir <path>`    | `~/.doompi/run`     | Parent of the session registry                   |
| `--web [port]`             | disabled, or `7433` | Start or join the browser cockpit                |
| `-- <agent arguments>`     | none                | Arguments passed to DoomPi                       |

Agent-side `--session-id` and `--name` values take precedence over the server options. The environment provides these operator overrides:

| Variable               | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| `DOOMPI_RUNTIME_DIR`   | Change the registry directory                     |
| `DOOMPI_AGENT_COMMAND` | Select a fallback JavaScript module or executable |
| `DOOMPI_API_DIR`       | Select a generated session API directory          |
| `DOOMPI_WEB_MODULE`    | Select the web module used by `--web`             |

## How the agent is selected

A headless session should follow the repository it runs inside. Selection therefore prefers:

1. the nearest repository-local `@agimon-ai/doompi` installation
2. `DOOMPI_AGENT_COMMAND` when no local installation exists
3. the installed DoomPi package composed in process

Composition errors stop startup before an agent is spawned or a registry record is published. A later major-mode change may relaunch the agent while the server identity and sockets stay in place. See [Lifecycle](lifecycle.md).

## Session registry

The default record is `<registry-dir>/sessions/<session-id>.json`. It contains the session identity, working directory, process ID, socket paths, creation time, and token file path.

DoomPi Web watches this directory and removes records whose process is no longer alive. A custom registry directory changes discovery, not authentication. Keep the registry private because its paths tell a local process where the session and credential live.

## Add the browser cockpit

Install the optional web package and pass `--web`:

```bash
npm install -g @agimon-ai/doompi-web

doompi-server \
  --listen "$runtime_dir/session.sock" \
  --auth-token-file "$runtime_dir/token" \
  --name work \
  --web \
  -- --major-mode copilot
```

If DoomPi Web already answers on port 7433, the server registers with that hub. Otherwise it starts a loopback cockpit in the same process.

For several sessions, start the hub independently:

```bash
doompi-web
```

Each server publishes a record under the same registry. The hub reads those records and holds one authenticated attachment per session. Browser authentication, remote tunnels, device cookies, and passkeys are owned by DoomPi Web, not this server.

## Stop and recover

`SIGINT` and `SIGTERM` stop the agent, close the sockets, and remove the registry record. A hard crash can leave files behind. A later server probes a stale socket before removing it, and DoomPi Web ignores records whose process is dead.

A live socket is never taken over silently. If another process still owns the requested path, startup fails.

## Development

Run from `packages/clients/doompi-server`:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Read [Security](security.md) before sharing a registry or runtime directory. Read [Session APIs](api.md) when a package needs an HTTP surface beside its agent.
