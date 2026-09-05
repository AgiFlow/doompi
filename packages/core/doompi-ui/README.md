# @agimon-ai/doompi-ui

DoomPi's shared terminal interface, Leader Space host, theme, overlays, and UI registries.

The [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi) loads this package as
core. Extension authors can depend on its public contracts without adopting the full distribution.

> **Alpha:** UI and contribution contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.85.0
- Pi TUI 0.85.0

## Install

To load the UI directly in Pi:

```bash
pi install npm:@agimon-ai/doompi-ui
```

DoomPi users should not add it to a layer; the distribution loads it before layer contributions.

## Commands and keys

| Input        | Behavior                                                                           |
| ------------ | ---------------------------------------------------------------------------------- |
| `Ctrl+Space` | Opens Leader Space from anywhere in the editor                                     |
| `SPC`        | Opens Leader Space only when the current draft is empty; otherwise inserts a space |
| `/tools`     | Opens the current tool and MCP inventory                                           |
| `/config`    | Opens settings contributed by active extensions                                    |

The registry rejects or diagnoses conflicting Leader contributions instead of silently replacing
an existing binding. Diagnostics are recorded through telemetry and shown as TUI warnings when a
UI is attached.

## Contribute to Leader Space

```ts
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';

export function reviewPlugin(ctx: Context): void {
  ctx.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
    const contribution = requireDoomUiHub(uiContext).registerLeader({
      source: '@example/review-extension',
      bindings: [
        {
          id: 'review.open',
          path: [{ key: 'r', label: 'review', detail: 'open review tools' }],
          command: { name: 'review' },
        },
      ],
    });
    return () => contribution.dispose();
  });
}
```

Mount this plugin beneath the shared Doom Cordis host. Cordis retracts the registration when either
the contributor or UI provider disappears, so reloads cannot retain stale bindings.

## TUI and headless sessions

The editor, header, footer, overlays, Leader menu, and notifications require an interactive TUI.
The underlying typed contribution registries can still be installed and queried in headless
sessions, but UI-only commands have no panel to render. Provide a tool, RPC, or CLI route when a
capability must also work headlessly.

## Theme

The package publishes `@agimon-ai/doompi-ui/themes/doom-pi-dark.json`. DoomPi synchronizes that
resource and selects it by default. Set `DOOMPI_THEME` to select another available Pi theme for the
UI adapter.

## Public API

Declared exports cover UI state, rendering, tool chrome, header/footer/editor components,
configuration and tools overlays, telemetry integration, and theme helpers. Contribution schemas
and the direct UI hub service live in extension contracts. Use these exports rather than importing
generated `dist` paths.

```ts
import { DOOM_UI_HUB_SERVICE } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { DEFAULT_THEME_NAME } from '@agimon-ai/doompi-ui/theme';
```

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
