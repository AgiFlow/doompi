# @agimon-ai/doompi-web-contracts

Web cockpit plugin contracts for DoomPi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

A DoomPi web plugin has two halves that share these types:

- A client entry exporting `webPlugin: WebPluginDefinition`, compiled into the cockpit bundle by
  the host package's build. It can contribute tabs with panels and badges, session data channels,
  overlays, Leader Space key bindings, command palette commands, rail, selection bar, and
  activity dock sections, and tool renderers: the web half of a tool's TUI `renderCall` and
  `renderResult`, a `call` component for the timeline card's header and a `result` component for
  its body, claimed by tool name (or by a `matches` predicate for tools named at runtime).
- An optional hub entry exporting `webHubChannels: readonly WebHubChannel[]`, loaded by the cockpit
  server at startup. A channel watches some data source and answers per-session payloads that reach
  the page as `ChannelFrame` messages whose frame type is the channel name.

Plugin packages declare both entries in a `doompiWeb` block in their package.json; the cockpit's
build scans the workspace and generates its registration modules from those blocks.

Use `defineWebPlugin` and `defineSessionChannel` for checked literals. Server code should import
these contracts type-only.

## License

MIT
