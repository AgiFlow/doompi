# Web plugins

A DoomPi web plugin adds browser behavior for a package selected by the DoomPi composition. It does not discover other plugins, create another shell, or load Node.js server code.

## Package declaration

Declare one browser source entry:

```json
{
  "doompiWeb": {
    "pluginId": "example",
    "client": "./src/exports/webClient.ts"
  }
}
```

`pluginId` is kebab-case. `client` is a package-relative source entry. The optional `registrationOrder` is a non-negative integer used only for deterministic installation order.

Do not declare `doompiWeb.hub`. Host-side channels and HTTP handlers belong to a `doompiServer` facet at `./src/exports/extensions/server.ts`.

## Client composition

The client entry exports one `webPlugin` definition:

```ts
import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';

export const webPlugin = defineWebPlugin({
  id: 'example',
  tabs: [],
  channels: [],
  toolRenderers: [],
});
```

The definition may contribute:

- tabs, dock faces, overlays, rail sections, selection bars, and composer actions
- activity groups, minor modes, and selection axes
- settings panels and fields
- palette commands, context actions, file links, and Leader Space bindings
- tool renderers and tool-prompt components
- named slots and fills
- session channels with parsers and browser stores
- a page-lifetime `start(runtime)` hook

The host supplies navigation, rendering, and session transport actions. Reuse those actions rather than opening a private transport.

## Server behavior

A client channel names browser-side parsing and state. Its producer runs in the headless process through a `doompiServer` facet. The facet registers typed channels or APIs with the server host and must release its own resources during cleanup.

This keeps server imports, credentials, watchers, and filesystem access outside the browser package and outside DoomPi Web.

## State ownership

Use `defineGlobalStore` for page state and `defineSessionStore` for records keyed by session ID. Validate channel payloads before applying them. A browser may reconnect to another package version or receive buffered data.

Plugins refer to named host slots rather than importing one another. A missing slot produces an installation diagnostic instead of a page failure.

## Build and activation

`doompi sync` validates browser manifests and compiles client definitions with Vite. The client composition shares the shell's React, TanStack Store, CodeMirror, web components, contracts, and browser security runtime.

Client code may import allowed browser runtimes plus its own browser and type modules. It must not import Node built-ins, server frameworks, server facets, or another plugin.

Client edits can hot reload through Vite. A server-facet change requires rebuilding the owning package and restarting the headless process.

## Failure policy

Optional plugin failure should remove one browser contribution, not the cockpit:

- no `doompiWeb` means no browser plugin
- malformed metadata or a missing client entry produces a sync notice
- duplicate plugin IDs and contribution names resolve deterministically
- a broken renderer falls back to the generic timeline item

`webPluginDiagnostics()` exposes browser installation diagnostics.
