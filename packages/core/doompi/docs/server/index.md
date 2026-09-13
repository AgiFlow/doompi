# Headless session server

**The canonical client-neutral server for a DoomPi session.**

`doompi-server` embeds a `DirectHarnessRuntime` and its typed session services in one process. It does not launch a second Pi process or expose an internal filesystem transport. Clients use the authenticated HTTP surface and the `/api/pi` WebSocket endpoint. A command-line server owns one session; the exported hub and session manager can host more than one session in a process.

The `@agimon-ai/doompi` core package owns this executable and the `@agimon-ai/doompi/server` API. It is a standalone process, not a Pi extension. Do not add it to `.doom/modes.yaml`.

## Install

Requires Node.js 22.19.0 or newer and a synchronized DoomPi installation.

```bash
npm install -g @agimon-ai/doompi
```

Run `doompi sync` in the session repository before starting the server. Startup requires the admitted generation and its `server.bundle.json` descriptor.

## Quick start

Create an owner-only token file, then pass harness arguments after `--`:

```bash
token_file="$(mktemp)"
(umask 077; openssl rand -base64 32 > "$token_file")

doompi-server \
  --auth-token-file "$token_file" \
  -- --major-mode copilot
```

The server listens on loopback port 7433 by default. Use `--web 9000` to select another port. The option name is retained for CLI compatibility, but the listener is the server's normal client-neutral HTTP and WebSocket surface, not an optional browser-only service.

The token is read from the file, not the command line. Keep the file private. A direct client presents the token to the HTTP routes and `/api/pi`; DoomPi Web can proxy the endpoint after applying its own browser and remote-access controls.

## How it works

Startup resolves an admitted synchronized generation, validates its descriptor, and loads the eligible server facets. It then creates the direct harness, session service, and package API handlers in process. The listener provides:

- `/api/pi`, an authenticated WebSocket carrying the Pi 0.85 Chord protocol;
- `/api/health`, an unauthenticated readiness check;
- `/api/sessions` and related routes for discovery and channel access; and
- session package APIs below `/api/sessions/<session-id>/api/<base-path>/...`.

The Pi protocol exposes typed management, hub, and session services. Session calls operate directly on the same runtime that owns the session journal. No raw command bridge, child-process fallback, or separate package API transport sits between a client and the runtime.

## Security

The server binds to loopback by default and requires the token for every route except `/api/health`. A token file keeps the capability out of process listings. The server is not a sandbox: the harness, extensions, and server facets run with the account's authority.

DoomPi Web owns browser authentication, remote tunnels, device cookies, and passkeys. When it proxies a session, browser code does not need the server token. Do not publish the server listener without an authenticated boundary.

Read [Security and trust boundaries](security.md) before sharing a listener or token.

## Guides

| Guide                                 | What it covers                                                    |
| ------------------------------------- | ----------------------------------------------------------------- |
| [Getting started](getting-started.md) | Installation, options, synchronization, and web integration       |
| [Lifecycle](lifecycle.md)             | In-process startup, readiness, shutdown, and history ownership    |
| [IPC](ipc.md)                         | The `/api/pi` protocol, typed operations, HTTP routes, and replay |
| [Session APIs](api.md)                | `server.bundle.json`, package handlers, and TypeScript exports    |
| [Security](security.md)               | Tokens, listener exposure, trusted code, and data boundaries      |

## License

[MIT](../../LICENSE)
