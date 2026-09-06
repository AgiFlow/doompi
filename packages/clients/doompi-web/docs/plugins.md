# Web plugins

A DoomPi web plugin adds browser behavior for a package already selected by the DoomPi composition. It does not install itself, discover other plugins, or create a second application shell.

The host owns navigation, session transport, shared UI primitives, and plugin activation. A plugin contributes definitions to those surfaces. This keeps the cockpit usable when an optional package is missing and lets two sessions use different plugin sets in the same browser.

## The plugin model

```text
package.json doompiWeb manifest
              |
      +-------+-------+
      |               |
      v               v
 client entry      optional hub entry
 exports           exports
 webPlugin         webHubChannels
      |               |
      v               v
 Vite composition  DoomPi Web hub
      |               |
      +-- session-scoped UI and data --+
```

The client entry describes presentation and page state. The optional hub entry owns host-side watchers, aggregation, or communication that should not run in the browser. A package may provide either side or both.

Plugins are independent. They refer to host surfaces and named slots rather than importing one another. `registrationOrder` is only a deterministic ordering hint, not a dependency graph.

The typed contract lives in [@agimon-ai/doompi-web-contracts](https://www.npmjs.com/package/@agimon-ai/doompi-web-contracts).

## Choose the smallest contribution

Use a client-only plugin when Pi RPC or an existing host action already supplies the data. Add a hub channel when the browser needs live host-side state that is not part of Pi RPC. Add a [package API](package-apis.md) when the operation is naturally request-response or belongs beside session-owned resources.

| Need                                               | Contract                             |
| -------------------------------------------------- | ------------------------------------ |
| Render a tab, tool call, setting, badge, or action | `webPlugin` contribution             |
| Maintain a live session-scoped stream or snapshot  | client channel plus `webHubChannels` |
| Read or mutate data through HTTP semantics         | `doompiApi` package API              |
| Change the base cockpit lifecycle or transport     | host code, not a plugin              |

This separation prevents panels from opening private sockets or inventing their own authorization path.

## Declare the package boundary

Add `doompiWeb` to the package manifest:

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

`pluginId` is kebab-case and identifies the client contribution. `channels` declares globally unique frame types shared by the browser and hub halves. `client` is a package-relative source entry. A non-host hub entry has both a source `entry` and a built `dist` module because the hub imports built Node.js code.

The optional `registrationOrder` is a non-negative integer. Lower values install first, then `pluginId` breaks ties.

## Client composition

A client entry exports one `webPlugin` definition:

```ts
import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';

export const webPlugin = defineWebPlugin({
  id: 'example',
  tabs: [],
  channels: [],
  toolRenderers: [],
});
```

The definition is declarative so the host can resolve all contributions before rendering. It can add:

- tabs, dock faces, overlays, rail sections, selection bars, and composer actions
- activity groups and sections, minor modes, and selection axes
- host-rendered setting fields or package-owned settings panels
- repository settings panels
- palette commands, context actions, file links, and Leader Space bindings
- tool renderers and optional tool-prompt components
- named slots and fills
- session channels with parsers and state stores
- a page-lifetime `start(runtime)` hook

The host supplies actions such as `openTab`, `openTransientTab`, `renderThread`, `renderSlot`, and `sendSessionFrame`. Reuse those actions rather than reaching around the host transport.

### State ownership

Use `defineGlobalStore` for state that belongs to the browser page and `defineSessionStore` for records keyed by session ID. A plugin may be installed for several sessions with different compositions, so module globals are rarely the right place for session state.

A session channel validates every payload before applying it. Unknown frame types are dropped. Validation belongs at this boundary because the browser may be reattaching to a different package version or receiving stale buffered data.

### Slots instead of plugin dependencies

A plugin opens a slot named `<pluginId>.<name>`. The host also exposes common slots such as overlays, rail regions, composer actions, and activity groups. Any installed plugin may contribute a fill by name without importing the slot owner.

Resolution happens after all definitions load. A fill whose slot is absent becomes an install diagnostic, not a page failure. This lets optional packages compose without making their install order a runtime dependency.

### Tool renderers

The package that registers a Pi tool should also claim its browser rendering. A renderer may name a fixed tool or use a matcher when the tool name is dynamic. It owns the complete message item and composes the shared `MessageItem` primitive so actions and visual behavior remain consistent.

If a renderer throws or no plugin claims the tool, the host uses its generic renderer. One broken tool view does not stop the timeline.

## Hub channels

A hub entry exports `webHubChannels`:

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

`start(host)` creates the channel's process-side resources. The host can list sessions, publish session payloads, send targeted frames, call a session package API, and report notices. `payloadFor(scope)` supplies the current snapshot when a browser subscribes. Optional session-added, session-removed, and inbound-frame handlers maintain live state.

`close()` must release watchers, timers, streams, and other resources. The hub may reload a session's selected composition without exiting the process.

The channel `frameType` must appear in the manifest's `channels` list and in the client channel definition. This explicit three-part agreement keeps undeclared wire protocols out of the cockpit.

## Build and activation

`doompi sync` scans the selected packages, validates manifests, generates imports, and compiles all client definitions for one composition. The server registry records built hub modules separately. See [Web bundling and serving](bundle.md) for the complete pipeline.

The client composition shares the shell's React, TanStack Store, CodeMirror, web components, contracts, and browser security runtime. Plugin client code may import those allowed runtimes plus its own `web/` and `src/types` modules. It must not import Node built-ins, a server framework, or another plugin.

The hub loads server entries lazily for the selected session. The browser verifies and activates the matching client composition when that session is focused. Switching focus disposes the active plugin UI and activates the target session's composition.

## Failure policy

Optional plugin failure should remove one contribution, not the cockpit:

- no `doompiWeb` means no browser plugin or hub channel
- malformed metadata or a missing optional entry produces a sync notice and is skipped when isolatable
- duplicate plugin IDs, channel names, tabs, tools, activity groups, or Leader leaves resolve deterministically and produce diagnostics
- a broken hub module omits its channels and leaves its panels empty
- a broken renderer falls back to the generic timeline item

`webPluginDiagnostics()` exposes client-side installation diagnostics. Repository contract tests hold the shipped composition to zero notices and diagnostics.

## Development loop

Run the hub and Vite client in separate terminals. Set `DOOMPI_WEB_PLUGIN_ROOTS` to a path-delimited list of plugin package roots when the package is not in the last synchronized composition.

Client edits hot reload because Vite compiles source. Hub entries are built Node.js modules, so a hub-side change requires a package build and hub restart. Tailwind class names in plugin source must be complete string literals so the build scanner can find them.

See [Getting started](getting-started.md) for commands and [Package APIs](package-apis.md) when a contribution needs HTTP semantics.
