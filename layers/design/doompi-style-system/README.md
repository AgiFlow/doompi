# @agimon-ai/doompi-style-system

Optional DoomPi integration for building disposable interactive story previews with `@agimon-ai/style-system`.

When this package and `@agimon-ai/doompi-author` are both installed, Author shows an **Open story preview** action. The temporary tab reads the focused `.stories.js`, `.stories.jsx`, `.stories.ts`, or `.stories.tsx` source, discovers exact named exports, builds only after an explicit action, runs the compiled HTML in an isolated iframe, and retains the composer for source-targeted feedback.

The portable `doompi-design` binary also works without Pi, DoomPi, Author, or MCP. Discovery commands delegate to the published style-system CLI. Structured commands provide exact story metadata, bounded checks, stale-evidence verification, and explicit preview builds:

```bash
doompi-design metadata --story-path src/Button.stories.tsx
doompi-design check --target docs/specs/button/design-target.json --report docs/specs/button/design-check.json
doompi-design verify --report docs/specs/button/design-check.json
doompi-design preview --app-path . --story-path src/Button.stories.tsx --story-export Playground --output .tmp/button.html
```

Use `--workspace <path>` when the process working directory is not the admitted project root.

## Opt in

Install both packages, then add them to a layer used by your selected major mode:

```yaml
layers:
  design:
    packages:
      - '@agimon-ai/doompi-author'
      - '@agimon-ai/doompi-style-system'
majorMode:
  design:
    description: Interactive source-backed story design.
    layers: [design]
```

The package is not added to DoomPi's default distribution mode.

Generated HTML is a preview artifact. AI changes must target the underlying story or component source. Refresh the preview after edits before treating it as visually verified.

## Image export

**Export PNG**, **Prepare annotation**, and **Send to AI** render a fresh image from current source through style-system. Users can mark one normalized region or comment on the whole frozen image. The image does not include transient interaction state inside the iframe, and the UI states this limitation instead of presenting it as an exact capture of iframe state.

## Security

Preview building executes trusted workspace source on the server. Project, story, and generated artifact paths are realpath-fenced to the admitted workspace. Browser previews use a script-only opaque-origin iframe and a restrictive content security policy. Remote assets are rejected by that policy, so preview assets must be included in the single-file bundle.

## Development

```bash
pnpm --filter @agimon-ai/doompi-style-system lint
pnpm --filter @agimon-ai/doompi-style-system typecheck
pnpm --filter @agimon-ai/doompi-style-system test
pnpm --filter @agimon-ai/doompi-style-system build
```
