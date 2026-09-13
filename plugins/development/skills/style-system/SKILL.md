---
name: style-system
description: Render DoomPi web components in a real browser and check their styling against the design tokens. Use when adding or changing a component's visual appearance, adding a story, adjusting styles/tokens.css, or when asked whether a surface looks right, not for non-visual React logic.
---

# Style System

`@agimon-ai/style-system` compiles a component with the real theme, screenshots it
in a headless browser, and hands the image back. Use it to see a component instead
of inferring how it looks from its class list.

## When it earns its cost

Reach for it when appearance is the question: a new component, a changed size or
tone ladder, an edit to `styles/tokens.css`, or a review that asks whether a
surface is correct. Skip it for logic, state, and data changes that do not move a
pixel.

## The three tools

| Tool                     | Use                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `list-shared-components` | Every component carrying the `style-system` tag. Takes no `--app-path`.                                     |
| `get-css-classes`        | The tokens the theme actually generates, read from `styles/tokens.css`.                                     |
| `get-ui-component`       | Compiles one story and returns a screenshot. `--component-name X --app-path <pkg> --story-name Playground`. |

Read `get-css-classes` before inventing a class. It reports only `--color-*`,
`--text-*`, `--font-*`, `--space-*`, `--spacing` and `--shadow-*`, so `--radius-*`
and `--tracking-*` are absent from its output even though they generate utilities.

## Configuration

`style-system.config.yaml` at the workspace root holds `defaults` and three presets;
each configured package extends one by name.

- `packages/core/doompi-web-components` extends `doom-components`
- `packages/clients/doompi-web` extends `doom-web-app`
- every package with a `src/web/components` tree extends `doom-plugin`

Resolution is `defaults` then the preset then the project file, replacing whole
values per field. There is no upward directory walk: a project config is read only
at the exact `--app-path` on the command line. `themePath` is workspace-root
relative; `cssFiles` entries are app-relative and must not contain `..`.

Keep stories inside a configured package. A story elsewhere resolves to the root
config, which is `root: true` and rejects being used as a project config.

### Adding a package

A package that renders stories needs three things, all cheap:

1. `style-system.config.yaml` containing `extends: doom-plugin`.
2. `styles/preview.css` importing `tailwindcss` and then
   `@agimon-ai/doompi-web-components/styles.css`. The library's `styles.css` is a
   package export, which is how a plugin reaches the palette without a `..` that
   `cssFiles` forbids. Tailwind has to be imported by hand, because the renderer
   only injects it for a project that configures no `cssFiles` at all.
3. `react-dom` as a devDependency. Plugin packages carry `react` but usually not
   `react-dom`, and under pnpm's strict layout the renderer then fails to resolve
   `react-dom/client` at build time.

## Stories

Storybook is not installed. A story is a plain object literal that the renderer
parses statically, preferring `Story.render`, then `meta.render`, then
`meta.component`.

```tsx
import { Thing } from './Thing.tsx';

const meta = {
  title: 'Components/Thing',
  component: Thing,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <span className="text-2xs uppercase tracking-widest text-doom-dim">size md</span>
      <Thing size="md" />
    </div>
  ),
};
```

Rules that make a story renderable:

- Never import from `storybook` or `@storybook/*`. Plain object literals only.
- `const meta` must be a bare declaration with `export default meta` after it.
  Writing `export const meta` breaks the render: the renderer finds the default
  export by looking for the bare declaration and otherwise reports the component
  as not found in the stories index. `no-default-export` and `direct-export-only`
  are therefore switched off for `src/components/*.stories.tsx` through an
  `overrides` block in the library's `vibe-lint.config.yaml`. Theming rules still
  apply to stories.
- `tags: ['style-system']` is what `list-shared-components` looks for.
- Relative imports carry their `.tsx` or `.ts` extension.
- It must paint with no interaction. Radix overlays need `open` or `defaultOpen`,
  `Tooltip` needs its provider, and portalled content needs a wrapper tall enough
  to screenshot.
- Show every rung a `cva` ladder declares, so a collapsed step is visible.
- A component taking `WebPluginSlotProps` or `ToolMessageRenderProps` gets them
  from `@agimon-ai/doompi-core/web/testing`, which already exports
  `slotPropsFixture` and `toolMessagePropsFixture`. A hand-rolled stub drifts
  silently when the contract changes; the fixture breaks at the type level.

Stories live in `src/` and never ship: `files` in `package.json` publishes `dist`
and `styles` only. `vitest.config.ts` excludes them from coverage.

## The token scales

Type, radius and tracking are closed sets. `no-arbitrary-style-value` in
`@agimon-ai/vibe-lint-plugin-doom-web` fails the build on anything outside them.

| Scale    | Rungs                                                                            |
| -------- | -------------------------------------------------------------------------------- |
| Type     | `text-2xs` 9px, `text-xs` 10px, `text-sm` 12px, `text-base` 13px, `text-lg` 15px |
| Radius   | `rounded-xs` 2px, `rounded-sm` 3px, `rounded-md` 5px, `rounded-lg` 10px          |
| Tracking | `tracking-wide` .08em, `tracking-wider` .14em, `tracking-widest` .18em           |
| Leading  | stock Tailwind steps; the theme adds none                                        |

Bare `rounded` is 4px, `rounded-full`, `rounded-none` and `rounded-t`/`rounded-b`
do not read `--radius-*` and are unaffected by the scale.

Adding a type step means restating its line height too. Overriding `--text-sm`
alone leaves Tailwind's default `--text-sm--line-height` in place, pairing a new
size with a stale ratio.

Colours are `--color-doom-*`. `text-doom-muted` is **not** one of them: the quiet
foreground is `text-doom-dim`. A class naming a token that does not exist compiles
to nothing and silently inherits, so confirm the name in `get-css-classes`.

## Verifying a change

1. `pnpm vibe-lint check --rules-only <paths>` before editing governed files.
2. Render the affected components and look at the screenshots.
3. `pnpm lint:vibe --preflight-only`.
4. `pnpm exec nx run-many -t lint typecheck build test -p <project>`.

Run Nx at `--parallel=3` or lower. Higher parallelism makes lint and typecheck
contend on shared build artifacts and report failures that vanish when rerun.

To confirm a token really compiles, build the CSS directly. The Tailwind v4 CLI has
no `--content` flag; point at sources with `@source "<absolute path>"` inside the
input CSS.

## Known quirks

- `get-css-classes` lists `--text-*--line-height` entries as though they were
  classes. Cosmetic; leave them.
- The renderer writes scratch Vite builds into `.tmp/` inside the package and never
  cleans them. Already git-ignored.
- The generated wrapper appends `@source` lines for `apps/` and
  `packages/frontend`, which this repository does not have. Tailwind ignores a
  missing source silently.
- The renderer serves the built page from `file://`, so a Web Worker cannot start:
  the browser blocks it as an origin `null` script. This bit `PdfPreview`, whose
  pdfjs import spun up a worker at module scope and so crashed every story in
  every package that imports the library barrel. The import is now lazy, which
  fixes the crash. A story that genuinely needs a worker to paint, such as the
  PDF canvas itself, still cannot: expect the chrome and the error state instead.
- A package renders against the library's built `dist`, not its sources. After
  changing a component, run `nx run @agimon-ai/doompi-web-components:build`
  before rendering a story from any other package.
