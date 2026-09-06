# Web plugins

DoomPi Web plugins are package contributions to the browser cockpit. A package can provide a client entry, an optional hub entry, or both. The package does not need to depend on another plugin.

The typed contract is [@agimon-ai/doompi-web-contracts](https://www.npmjs.com/package/@agimon-ai/doompi-web-contracts). The host uses the same package set for the client composition and for the server-side channel registry.

## Declare a plugin

Add a `doompiWeb` block to `package.json`:

```json
{
  "doompiWeb": {
    "pluginId": "example",
    "channels": ["example_status"],
    "client": "./src/exports/webClient.ts",
    "hub": {
      "entry": "./src/exports/webHub.ts",
      "dist": "./dist/webHub.mjs"
    }
  }
}
```

`pluginId` is kebab-case and identifies the client contribution. `channels` lists globally unique wire frame types. The client entry is a package-relative source entry and must export `webPlugin`. A non-host hub entry must include a package-relative built `dist` entry and must export `webHubChannels`.

The optional `registrationOrder` is a non-negative integer. It orders independent plugins before `pluginId` breaks ties. It does not create a dependency between packages.

Examples in the repository include:

- `doompi-plan`, which contributes a minor mode, activity section, settings fields, and plan tool renderers.
- `doompi-runner`, which contributes a session channel, runner activity UI, and `bash` tool rendering.
- `doompi-mcp`, which contributes repository settings, session context UI, and matcher-based MCP tool rendering.

## Client entry

A client entry normally re-exports a definition:

```ts
import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';

export const webPlugin = defineWebPlugin({
  id: 'example',
  tabs: [],
  channels: [],
  toolRenderers: [],
});
```

A definition can contribute:

- tabs, dock faces, overlays, rail sections, selection bar items, and composer actions
- session channels backed by a parser and per-session state
- activity groups and sections, minor modes, and selection axes
- settings sections rendered by the host, or package-owned settings panels
- repository settings panels
- slots and fills for named cross-plugin composition
- palette commands, context actions, and Leader Space bindings
- file links for paths shown in messages
- tool renderers and optional tool prompt components
- a page-lifetime `start(runtime)` function

Use `defineGlobalStore` for page-wide state and `defineSessionStore` for records keyed by session ID. A session channel must validate wire data before applying it. Components receive host actions such as `openTab`, `openTransientTab`, `renderThread`, `renderSlot`, `sendSessionFrame`, and composer context helpers.

The host resolves slots by name after all installed plugins load. Plugin-owned slots are namespaced as `<pluginId>.<name>`. A fill into an undeclared slot is an install diagnostic, not a page failure.

## Hub entry and channels

A hub entry exports an array of `WebHubChannel` values:

```ts
import type { WebHubChannel } from '@agimon-ai/doompi-web-contracts';

export const webHubChannels: readonly WebHubChannel[] = [
  {
    frameType: 'example_status',
    start(host) {
      return {
        payloadFor: (scope) => ({ cwd: scope.cwd }),
        close: () => undefined,
      };
    },
  },
];
```

A channel starts with a host that can list sessions, publish a payload to a session, send targeted frames, request a session package API, and report a notice. `payloadFor` supplies a subscription snapshot. A channel can react to sessions being added or removed and can receive frames from authenticated browser sockets. `close()` must release timers, watchers, and other resources.

The channel's `frameType` must match a name in the plugin's `channels` declaration. The browser-side session channel parses the payload and updates its session store. Unknown frame types are dropped.

## Build and load behavior

`doompi sync` scans the installed package composition, validates each manifest, generates import modules, and builds:

- the host SPA and plugin client source
- the plugin composition entry and Vite manifest
- the server registry for built hub entries
- package API route modules

The hub loads built non-host hub entries lazily for the selected session composition. The browser composition is compiled with shared React, TanStack Store, CodeMirror, web components, and web security runtimes deduplicated. This includes one sealed-transport singleton and one set of nonce counters.

Client code may import the contract, React, TanStack Store, `@agimon-ai/doompi-web-components`, the browser security helper, and its own `web/` and `src/types` modules. Do not import Node built-ins, a server framework, or another plugin from client code. Tailwind classes must be complete literal strings so the host scanner can see them.

For local client work, use `DOOMPI_WEB_PLUGIN_ROOTS` with `pnpm dev` as described in [Getting started](getting-started.md). A client edit hot reloads through Vite. A hub entry edit requires a package build and hub restart.

## Missing packages and collisions

Plugin metadata is optional. A package without `doompiWeb` contributes no browser plugin or hub channel. A malformed block or unavailable entry produces a notice and is skipped when it can be isolated. The base cockpit remains available.

Duplicate plugin IDs, channel names, tab IDs, tool names, activity groups, or Leader leaves are install diagnostics. Resolution is deterministic and the page continues with the winning contribution. `webPluginDiagnostics()` exposes client diagnostics, and sync notices identify packages skipped on the server side.
