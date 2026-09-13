# Getting started

`doompi-server` is the process boundary for one client-neutral headless DoomPi session. It embeds the Pi harness, typed session services, and package facets in one process, then publishes an authenticated HTTP and WebSocket listener.

## Choose the topology

Use the server directly for a local client or a durable headless session:

```text
client -> authenticated HTTP/WebSocket listener -> doompi-server
                                      \-> DirectHarnessRuntime
```

Add DoomPi Web when a browser or remote cockpit should control the session:

```text
browser -> DoomPi Web -> authenticated /api/pi WebSocket -> doompi-server
                                                     \-> DirectHarnessRuntime
```

DoomPi Web owns browser authentication and remote-access policy. A direct client is responsible for presenting the server token.

## Requirements

- Node.js 22.19.0 or newer
- A session repository with a successful `doompi sync`
- A private token file

The synchronized generation must contain the admitted `server.bundle.json` descriptor. The server does not discover arbitrary package modules at startup.

Install core, which owns the `doompi-server` executable:

```bash
npm install -g @agimon-ai/doompi
```

## Start a session

```bash
token_file="$(mktemp)"
(umask 077; openssl rand -base64 32 > "$token_file")

doompi-server \
  --auth-token-file "$token_file" \
  --name work \
  -- --major-mode copilot
```

Server options come before `--`. Everything after it configures the embedded harness. The server validates those arguments, resolves the synchronized composition, creates a direct runtime, and waits for that runtime to exit.

The token is a session-control capability. It is read from the file so it does not appear in the server argument list. The server rejects an empty token but does not create or protect the file for you. Keep the file in a private directory with restrictive permissions.

## What startup creates

A ready session owns:

| Resource                        | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| Loopback HTTP listener          | Health, discovery, channel, and package API routes       |
| `/api/pi` WebSocket             | Authenticated Pi 0.85 Chord protocol                     |
| Direct harness runtime          | In-process Pi execution and typed session operations     |
| Session journal                 | Upstream v4 JSONL history, normally below `.pi/sessions` |
| `server.bundle.json` generation | Pinned server facet declarations and modules             |

No separate API listener or filesystem endpoint is created. The session service hydrates its authoritative snapshot from the journal and publishes it through the protocol state.

## Command options

| Option                     | Default        | Meaning                                                 |
| -------------------------- | -------------- | ------------------------------------------------------- |
| `--auth-token-file <path>` | required       | File containing the listener token                      |
| `--name <name>`            | `untitled`     | Session name shown by clients                           |
| `--session-id <id>`        | generated UUID | Stable session identity; it must not contain `/`        |
| `--web [port]`             | 7433           | Listener port; the listener is started for every server |
| `-- <harness arguments>`   | none           | Arguments passed to the embedded headless harness       |

There is no server-side command, runtime-directory, or API-directory fallback. Composition comes from the admitted synchronized generation. A missing or malformed descriptor fails startup instead of selecting a different module set.

## Select the runtime composition

The server follows the repository selected by the synchronized registration for the session working directory. It validates the generation and fingerprint, loads `server.bundle.json`, filters entries for the active major mode and layers, and installs the resulting facets into the direct headless host.

The server does not select an executable or use an alternate runtime when the admitted generation is unavailable. Re-run `doompi sync` and restart after changing server facets or their generated bundle.

## Add the browser cockpit

DoomPi Web can proxy the server's `/api/pi` endpoint:

```bash
npm install -g @agimon-ai/doompi-web

doompi-web
```

Configure the cockpit with the server URL and token through its documented pairing and discovery flow. The browser connects to the web surface, not to a private server credential. The server remains responsible for token validation at its listener.

## Stop and recover

`SIGINT` and `SIGTERM` dispose the headless host, close package facets, stop the direct runtime, close the listener, and release history ownership. A normal stop leaves the v4 session journal available for a later server.

If startup fails while loading the generation or a required facet, no ready listener is published. Treat a failed descriptor, failed required facet, or history ownership conflict as a readiness failure, not as permission to use another generation.

## Development

Run from `packages/core/doompi`:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Read [Security](security.md) before sharing a listener or token. Read [Session APIs](api.md) when a package needs a session HTTP surface.
