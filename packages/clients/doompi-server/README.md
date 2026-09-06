# @agimon-ai/doompi-server

**A headless server for one DoomPi session.**

`doompi-server` owns one Pi RPC agent behind local Unix sockets. A client can disconnect and reattach while the agent keeps running. The server also publishes Pi's routed protocol, optional package APIs, and a registry record used by DoomPi Web.

This is a standalone process, not a Pi extension. Do not add it to `.doom/modes.yaml`.

## Install

Requires Node.js 22.19.0 or newer and a DoomPi installation.

```bash
npm install -g @agimon-ai/doompi-server
```

## Quick start

Create a private runtime directory and token, then pass agent arguments after `--`:

```bash
runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/doompi-session.XXXXXX")"
(umask 077; openssl rand -base64 32 > "$runtime_dir/token")

doompi-server \
  --listen "$runtime_dir/session.sock" \
  --auth-token-file "$runtime_dir/token" \
  -- --major-mode copilot
```

The token is read from the file, not the command line. Keep the runtime directory private.

Add `--web` to start or join DoomPi Web on port 7433. A standalone `doompi-web` process is the better choice when several sessions share one cockpit.

See [Getting started](docs/getting-started.md) for command options, agent selection, registry configuration, and the web integration.

## How it works

The server resolves the configured DoomPi installation and starts one agent in RPC mode. It opens three local transports:

- `--listen` is the token-protected framed session socket.
- `<listen>.pi` is the Pi routed protocol socket.
- `api.sock` serves optional session package APIs.

After the transports are ready, the server writes an owner-only registry record. DoomPi Web reads that record to find the sockets and token file. The token itself is not stored in the record, but the paths are sensitive and the registry must remain private.

The framed socket allows one attached client. If it disconnects, the agent continues and the server keeps a bounded in-memory replay window. A major-mode change that needs a different extension composition relaunches the agent while keeping the server, session ID, sockets, and registry record.

See [Lifecycle](docs/lifecycle.md) for startup and relaunch behavior, [IPC](docs/ipc.md) for wire contracts, and [Session APIs](docs/api.md) for package handlers and TypeScript exports.

## Security

The server listens on Unix sockets, not public network ports. Filesystem permissions protect the Pi protocol and package API sockets. The framed session socket also requires the attach token. These controls do not defend against root, a compromised owner account, or trusted package code.

A browser never receives the Unix attach token. Remote browsers authenticate to DoomPi Web with a separate device cookie, and the web package owns the remote-access boundary. Do not expose any server socket through an unauthenticated TCP forwarder.

Read [Security and trust boundaries](docs/security.md) before sharing a runtime directory or connecting the server to a remote cockpit.

## Guides

| Guide                                      | What it covers                                             |
| ------------------------------------------ | ---------------------------------------------------------- |
| [Getting started](docs/getting-started.md) | Installation, options, registry, and web integration       |
| [Lifecycle](docs/lifecycle.md)             | Startup, agent selection, relaunches, and shutdown         |
| [IPC](docs/ipc.md)                         | Unix sockets, attach and replay, framing, and Pi protocol  |
| [Session APIs](docs/api.md)                | Package API routes and the TypeScript export surface       |
| [Security](docs/security.md)               | Permissions, tokens, trusted inputs, and remote boundaries |

## License

[MIT](LICENSE)
