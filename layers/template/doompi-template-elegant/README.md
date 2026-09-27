# DoomPi Elegant template

An independently installable, chat-first web template. Conversations use a centered reading column. Navigation and activity open in accessible drawers, while session controls expand on demand. Plugin panels and settings keep the full available width.

Append `@agimon-ai/doompi-template-elegant` to the existing `default.packages` list in `~/.pi/.doom/modes.yaml` or your repository's `.doom/modes.yaml`. Keep the other entries. A repository `default` replaces the personal list rather than merging individual packages.

Packages can also live in a layer selected by a major mode. Refresh the composition with `doompi sync` after adding or removing packages.

Open **Settings > Appearance > Template**, choose the configuration scope, select **Elegant**, and click **Set as default**. The equivalent configuration is:

```yaml
web:
  template: doompi-template-elegant
```

Global defaults live in `~/.pi/.doom/config.yaml`. Workspace defaults live in `.doom/config.yaml` and override the global value. Clearing a workspace default restores inheritance.

A template changes presentation, not the active tools, session runtime, or color theme. The host supplies header, notices, content, composer, session controls, and activity slots, plus the session rail as data and actions (`rail`). The template renders the rail itself: workspaces, session cards, and the add-workspace dialog (render that dialog at the layout root so it opens while a drawer is closed). The new-session, resume, and remote-access dialogs, the keyboard shortcuts, approval and security overlays stay with the host.

## Package contract

The routed `template/*.web.ts` contributions are compiled by `@agimon-ai/doompi-build`. The generated Pi entry admits the package through normal `modes.yaml` resolution but registers no tools or minor modes. Browser code is emitted to `dist/extensions/web.mjs` and discovered through `doompiWeb` metadata.

The layout implements `WebTemplateProps` and template contract version 1 from `@agimon-ai/doompi-core/web`. There is no dependency on the web client's private stores or router.

## Development

```sh
pnpm exec nx run-many -t lint typecheck build test -p @agimon-ai/doompi-template-elegant --parallel=2
```
