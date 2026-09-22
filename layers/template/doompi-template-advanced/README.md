# DoomPi Advanced template

An independently installable, slot-based web template with persistent desktop session navigation and an activity dock. Mobile panels use accessible drawers.

Append `@agimon-ai/doompi-template-advanced` to the existing `default.packages` list in `~/.pi/.doom/modes.yaml` or your repository's `.doom/modes.yaml`. Keep the other entries. A repository `default` replaces the personal list rather than merging individual packages.

Packages can also live in a layer selected by a major mode. Refresh the composition with `doompi sync` after adding or removing packages.

Open **Settings > Appearance > Template**, choose the configuration scope, select **Advanced**, and click **Set as default**. The equivalent configuration is:

```yaml
web:
  template: doompi-template-advanced
```

Global defaults live in `~/.pi/.doom/config.yaml`. Workspace defaults live in `.doom/config.yaml` and override the global value. Clearing a workspace default restores inheritance.

A template changes presentation, not the active tools, session runtime, or color theme. The host supplies navigation, header, notices, content, composer, session controls, and activity slots. Approval and security overlays stay outside the template.

## Package contract

The routed `template/*.web.ts` contributions are compiled by `@agimon-ai/doompi-build`. The generated Pi entry admits the package through normal `modes.yaml` resolution but registers no tools or minor modes. Browser code is emitted to `dist/extensions/web.mjs` and discovered through `doompiWeb` metadata.

The layout implements `WebTemplateProps` and template contract version 1 from `@agimon-ai/doompi-core/web`. There is no dependency on the web client's private stores or router.

## Development

```sh
pnpm exec nx run-many -t lint typecheck build test -p @agimon-ai/doompi-template-advanced --parallel=2
```
