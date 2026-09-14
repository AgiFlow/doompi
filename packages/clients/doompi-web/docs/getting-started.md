# Getting started

DoomPi Web is the browser presentation process. It serves the SPA and PWA, then forwards HTTP and WebSocket traffic to the client-neutral `doompi-server`. It does not load server extensions, own sessions, launch agents, or enforce API authorization.

## Requirements

- Node.js 22.19.0 or newer
- A synchronized DoomPi web bundle when using repository browser plugins

## Install and start

```bash
doompi-web
```

Open <http://127.0.0.1:7433>. One command is enough: the presentation process starts a headless `doompi-server` on `127.0.0.1:7434`, generates a single-use credential in a private file, forwards it on every proxied request, and stops the child when it exits.

If port `7434` is occupied, it starts its own authenticated backend on an available port. It starts nothing when `--headless-url` or `--headless-token` explicitly names a headless process someone else runs:

```bash
# terminal 1
doompi-server --auth-token-file ./headless.token --no-session --web 7434

# terminal 2
doompi-web --headless-url http://127.0.0.1:7434 --headless-token "$(cat ./headless.token)"
```

`doompi-server` requires `--auth-token-file` and reads the credential from that file rather than a flag, because command arguments are visible to other local processes. Its `--web` port defaults to `7433`, so pass `--web 7434` to leave `7433` for the browser assets.

The credential is added by the presentation proxy and is not embedded in browser assets. Keep both listeners on loopback unless an authenticated deployment boundary is configured in front of them.

## Command reference

| Option                 | Default           | Effect                                      |
| ---------------------- | ----------------- | ------------------------------------------- |
| `--port <number>`      | `7433`            | Select the browser presentation HTTP port   |
| `--host <address>`     | `127.0.0.1`       | Select the presentation bind address        |
| `--assets <path>`      | packaged shell    | Override the built SPA directory            |
| `--headless-url <url>` | started on `7434` | Attach to an existing headless endpoint     |
| `--headless-token`     | generated per run | Forward a credential to the headless server |
| `DOOMPI_WEB_DIST`      | unset             | Environment equivalent of `--assets`        |

`doompi-web --help` prints the current syntax. `doompi-web --version` prints the installed version without loading the server.

## Develop browser plugins

Use separate terminals for the headless endpoint and the Vite development server:

```bash
# repository root
pnpm nx run @agimon-ai/doompi:build
doompi-server --auth-token-file ./headless.token --no-session --web 7434

# packages/clients/doompi-web
pnpm dev
```

The Vite server proxies `/api`, including the session WebSocket, to the headless endpoint. Browser plugin entries hot reload because Vite compiles their source. Server facets are loaded only by the headless process and must never be imported by the web development server.

## Verify a package change

Run from the repository root:

```bash
pnpm nx run @agimon-ai/doompi-web:typecheck --skip-nx-cache
pnpm nx run @agimon-ai/doompi-web:test --skip-nx-cache
pnpm nx run @agimon-ai/doompi-web:lint --skip-nx-cache
pnpm nx run @agimon-ai/doompi-web:build --skip-nx-cache
```

See [Web plugins](plugins.md) for browser contribution contracts and [Architecture](architecture.md) for process ownership.
