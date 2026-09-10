# @agimon-ai/doompi-web

**A browser cockpit for your DoomPi sessions.**

DoomPi Web finds running [`doompi-server`](https://www.npmjs.com/package/@agimon-ai/doompi) sessions, keeps their attach credentials on the host, and presents them through one browser connection. It is a standalone process, not a Pi extension. Do not add it to `.doom/modes.yaml`.

## Install

Requires Node.js 22.19.0 or newer and a synchronized DoomPi configuration.

```bash
npm install -g @agimon-ai/doompi-web
doompi-web
```

Open <http://127.0.0.1:7433>. The cockpit can discover existing session servers or start one when you create a session from the page.

Use `doompi-web --dir "$PWD"` when working with a repository-specific composition. It synchronizes that repository before launch and before new or restarted sessions. It does not watch the repository for later changes.

See [Getting started](docs/getting-started.md) for command options, environment variables, remote setup, and the plugin development loop.

## How it works

The hub watches the session registry and attaches to each server over its authenticated Unix socket. The browser talks to the hub through one WebSocket, with every frame keyed by session. Closing a tab does not stop the agent, and the hub keeps a bounded replay window for reconnects.

DoomPi first resolves repository configuration into the ordered extension composition used by the TUI. `doompi sync` publishes that composition and its related artifacts as one immutable generation. DoomPi Web reads the same generation, but loads browser plugins, hub channels, and APIs instead of the TUI runtime bundle. The browser shell itself ships with this package.

Packages extend the cockpit in two ways:

- `doompiWeb` adds browser UI and optional hub channels. See [Web plugins](docs/plugins.md).
- `doompiServer` declares a server facet that registers HTTP handlers in the hub or session host. See [Package APIs](docs/package-apis.md).

See [Composition and runtime bundling](../../../docs/bundling.md) for the TUI path. [Web bundling and serving](docs/bundle.md) explains why the shell and plugins are separate, what sync builds, how a session selects its artifacts, and how the hub serves them.

## Remote access

Remote access is access to an agent that may have shell tools. Keep the normal listener on loopback. Do not publish it with `--host 0.0.0.0` and assume it is protected.

The remote flow uses a separate tunnel listener, host-approved pairing, and a device cookie. After pairing, session traffic and API payloads use sealed channels. Pairing, passkey, and PWA bootstrap routes remain unsealed so a device can establish trust. Signed bundles protect later asset delivery, but cannot authenticate the first verifier page served by the tunnel.

Passkeys and step-up checks require a stable named tunnel. Quick tunnels have rotating hostnames and skip those checks. The optional container boundary limits which host workspaces the remote cockpit can reach, but it does not make mounted workspaces read-only or remove trust from the container engine.

Read [Remote security](docs/security.md) before enabling a tunnel. It covers cookies, passkeys, sealing, signed bundles, Push, containment, and the limits of each control.

## Guides

| Guide                                      | What it covers                                                        |
| ------------------------------------------ | --------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md) | Installation, sessions, sync, options, and development                |
| [Architecture](docs/architecture.md)       | Hub, session servers, sockets, and lifecycle ownership                |
| [Web plugins](docs/plugins.md)             | Plugin manifests, browser entries, hub channels, and UI contributions |
| [Package APIs](docs/package-apis.md)       | API scopes, route selectors, and caller context                       |
| [Web bundling and serving](docs/bundle.md) | Design choices, build outputs, per-session selection, and serving     |
| [Remote security](docs/security.md)        | Pairing, cookies, passkeys, sealed transport, and containment         |

## Programmatic use

```ts
import { serveWeb } from '@agimon-ai/doompi-web';
import { bundleCockpitWeb } from '@agimon-ai/doompi-web/bundler';
```

## License

Source is available under the [DoomPi Web License](LICENSE). Use is free for production and commercial purposes, but redistribution and offering the software as a hosted or managed service are not permitted.
