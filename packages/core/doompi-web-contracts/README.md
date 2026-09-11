# @agimon-ai/doompi-web-contracts

Typed browser plugin, slot, session-channel, and presentation contracts for the DoomPi web cockpit.

This is a library, not a Pi extension. It starts no process and does not belong in `.doom/modes.yaml`.

> **Alpha:** web plugin contracts may change between releases.

## Install

```bash
npm install @agimon-ai/doompi-web-contracts
```

Web plugin clients also require the package's React, React DOM, and TanStack Store peers when they use
those surfaces.

## Plugin shape

A web plugin has one browser client entry exporting `webPlugin: WebPluginDefinition`. It can contribute tabs, slots, Leader bindings, commands, browser session channels, activity surfaces, and tool renderers.

Declare that entry as `doompiWeb.client` in the plugin package manifest. Server-owned APIs and live channels belong to the package's canonical `doompiServer` facet, not to a web plugin entry.

Use the definition helpers for checked literals:

```ts
import {
  defineSessionChannel,
  defineSessionStore,
  defineSlot,
  defineWebPlugin,
  toolResultText,
} from '@agimon-ai/doompi-web-contracts';
```

The `/testing` subpath provides browser channel, render, slot, and tool-message fixtures for plugin tests.

## License

MIT
