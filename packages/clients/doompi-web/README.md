# @agimon-ai/doompi-web

**A browser cockpit for DoomPi sessions.**

DoomPi Web is a presentation-only process. It serves the browser shell and PWA, bundles browser plugins, and proxies `/api` HTTP and WebSocket traffic to the client-neutral `doompi-server`. Session state, native Team children, APIs, channels, authorization, history, and replay stay in the headless process.

## Install

Requires Node.js 22.19.0 or newer.

```bash
npm install -g @agimon-ai/doompi-web
doompi-web
```

Open <http://127.0.0.1:7433>. The presentation process starts a headless `doompi-server` on `127.0.0.1:7434`, forwards a generated credential to it, and stops it on exit.

Pass `--headless-url` or `--headless-token` to attach to a headless process someone else runs; the presentation process then starts nothing. If the default backend port is occupied, it starts its own authenticated child on an available port. The credential is forwarded by the proxy and never embedded in browser assets.

## Extension surfaces

Packages contribute browser UI through `doompiWeb.client`. Server channels and APIs are declared through `doompiServer` and loaded only by the headless process. DoomPi Web does not load a server half of a browser plugin.

## Guides

| Guide                                      | What it covers                                      |
| ------------------------------------------ | --------------------------------------------------- |
| [Getting started](docs/getting-started.md) | Startup, proxy options, and browser development     |
| [Architecture](docs/architecture.md)       | Browser, presentation proxy, and headless ownership |
| [Web plugins](docs/plugins.md)             | Browser plugin declarations and UI contributions    |
| [Package APIs](docs/package-apis.md)       | Headless API scopes and caller context              |
| [Web bundling and serving](docs/bundle.md) | Browser build outputs and serving                   |
| [Remote security](docs/security.md)        | Browser transport and deployment boundaries         |
| [Session MCP](docs/session-mcp.md)         | Exposing a live session to a custom MCP connector   |

## Programmatic use

```ts
import { serveWeb } from '@agimon-ai/doompi-web';
import { bundleCockpitWeb } from '@agimon-ai/doompi-web/bundler';
```

## License

Source is available under the [DoomPi Web License](LICENSE). Use is free for production and commercial purposes, but redistribution and offering the software as a hosted or managed service are not permitted.
