# @agimon-ai/doompi-web

DoomPi Web is a standalone Node.js process that serves the DoomPi browser cockpit. It discovers registered `doompi-server` sessions, keeps their attach credentials on the host, and presents them through one browser connection.

This package is not a Pi extension. Do not add it to `.doom/modes.yaml`.

## Requirements

- Node.js 22.19.0 or newer
- A DoomPi installation with at least one synchronized configuration

The cockpit can start `doompi-server` processes itself. Existing servers are discovered through the session registry.

## Install and run

```bash
npm install -g @agimon-ai/doompi-web
doompi-web
```

Open <http://127.0.0.1:7433>. The default listener is loopback. If the personal DoomPi directory does not exist, startup runs the bundled `doompi init` before serving.

With no `--dir`, the hub uses the global synchronized configuration as its default and watches that global configuration for completed syncs. Each session still resolves its web composition from its own repository first, with the global composition as fallback. A repository passed with `--dir` must be inside a repository. It is synchronized before launch and before a new or restarted session, but it is not watched. Run `doompi sync` and restart or create a session to adopt repository changes.

### Command options

| Option                      | Default                  | Purpose                                                                      |
| --------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `--dir <path>`              | none                     | Select and synchronize one repository composition                            |
| `--registry-dir <path>`     | `~/.doompi/run`          | Session registry; `DOOMPI_RUNTIME_DIR` is an equivalent environment override |
| `--spawn-command <command>` | bundled server           | Command used for sessions created from the cockpit                           |
| `--port <number>`           | `7433`                   | Loopback HTTP port                                                           |
| `--host <address>`          | `127.0.0.1`              | Bind address; a non-loopback address is not paired or authenticated          |
| `--assets <path>`           | packaged or synchronized | Override the host shell assets                                               |
| `--state-dir <path>`        | `~/.doompi/web`          | Remote-access state and cockpit cache                                        |
| `--cloudflared <path>`      | `PATH`                   | Explicit `cloudflared` binary                                                |

`--assets` can also be set with `DOOMPI_WEB_DIST`. `DOOMPI_API_DIR` overrides the default generated package API directory. Use `doompi-web --help` for the complete command help.

## How it works

The hub watches the session registry and attaches to each registered `doompi-server` using the token file named by that record. Attach tokens remain in the hub process. A browser page uses one WebSocket, while hub and session frames remain keyed by session ID. The hub buffers a bounded history for reconnects and rejects browser-supplied attach frames.

The host shell is packaged with this module. Synchronized repositories contribute per-session plugin compositions, hub channels, and package API routes. A selected composition is complete or it is not used, and repository and global artifacts are never mixed inside one session. See [bundle resolution](docs/bundle.md) and [architecture](docs/architecture.md).

The cockpit also serves a PWA install shell and service worker. After a paired device installs the PWA, the worker verifies signed host and plugin assets before putting them in the active cache. Optional closed-app Web Push notifications are generic, zero-TTL alerts kept in memory by the running hub. They are not a durable notification queue.

## Extending the cockpit

A DoomPi package can declare a browser plugin in `package.json` under `doompiWeb`. Its client entry exports `webPlugin`; an optional hub entry exports `webHubChannels`. Plugins can add tabs, dock and activity sections, settings, session channels, slots, Leader bindings, context actions, and tool renderers. Plugins are independent and optional. See [web plugins](docs/plugins.md) and the typed [web plugin contracts](https://www.npmjs.com/package/@agimon-ai/doompi-web-contracts).

A package can expose HTTP endpoints under `doompiApi`. Session APIs run with a session server. Hub APIs run with the cockpit hub. Both use the package API `basePath` and `start(context)` contract. See [package APIs](docs/package-apis.md).

For direct programmatic use:

```ts
import { serveWeb } from '@agimon-ai/doompi-web';
import { bundleCockpitWeb } from '@agimon-ai/doompi-web/bundler';
```

## Remote access and security

Remote access is intentionally an authenticated path to an agent that can hold shell tools. Enabling it creates a second loopback listener for the tunnel and leaves the normal local listener unchanged. Pairing requires a code and approval on the host. A paired browser receives a device bearer cookie, not a session attach token.

Remote session traffic, protocol traffic, and API bodies use a sealed channel after pairing. Pairing, passkey, and PWA bootstrap routes are intentionally unsealed. Signed bundle verification protects asset delivery only after the signing key and the initial bootstrap are trusted. The tunnel provider can still observe the page, asset requests, timing, sizes, and connection metadata.

The default loopback origin and host checks help against hostile web pages and DNS rebinding. They do not protect against a hostile local process. Do not publish the listener with `--host 0.0.0.0`; use the paired remote-access flow or a trusted SSH tunnel. See [remote security](docs/security.md), including passkeys, step-up actions, sealed transport, signed bundles, and the optional container boundary.

## Documentation

- [Getting started](docs/getting-started.md): installation, sync, sessions, and development setup
- [Architecture](docs/architecture.md): process boundaries, sockets, lifecycle, and browser composition
- [Web plugins](docs/plugins.md): manifests, client and hub entries, contributions, and compatibility
- [Package APIs](docs/package-apis.md): `doompiApi`, route mounting, selectors, and caller context
- [Bundle resolution](docs/bundle.md): synchronized generations, fallback, publication, and overrides
- [Remote security](docs/security.md): pairing, passkeys, sealing, bundle trust, and containment limits

## Development

Run from this package directory:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm lint
```

Build before running the end-to-end suite. The package is maintained by [Agimon](https://agimon.ai/about).

## License

Source is available under the [DoomPi Web License](LICENSE). Use is free for production and commercial purposes, but redistribution and offering the software as a hosted or managed service are not permitted.
