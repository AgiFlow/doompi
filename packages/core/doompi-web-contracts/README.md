# @agimon-ai/doompi-web-contracts

Typed plugin, slot, session-channel, and hub-channel contracts for the DoomPi web cockpit.

This is a library, not a Pi extension. It starts no process and does not belong in `.doom/modes.yaml`.

> **Alpha:** web plugin contracts may change between releases.

## Install

```bash
npm install @agimon-ai/doompi-web-contracts
```

Web plugin clients also require the package's React, React DOM, and TanStack Store peers when they use
those surfaces.

## Plugin shape

A web plugin can have two entries:

- A client entry exports `webPlugin: WebPluginDefinition`. It can contribute tabs, slots, Leader
  bindings, commands, session channels, activity surfaces, and tool renderers.
- An optional hub entry exports `webHubChannels: readonly WebHubChannel[]`. Each channel watches a
  data source and emits per-session `ChannelFrame` payloads to the page.

Declare both entries in the plugin package's `doompiWeb` manifest block. The DoomPi cockpit bundler
reads those declarations and generates the registration modules.

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

Import contracts type-only from server code. The `/testing` subpath provides channel, render, slot,
and tool-message fixtures for plugin tests.

## License

MIT
