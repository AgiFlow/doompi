# @agimon-ai/doompi-web-components

Shared web components and theme tokens for the DoomPi cockpit and its web plugins. It is the
browser counterpart of [doompi-ui](https://www.npmjs.com/package/@agimon-ai/doompi-ui): where that
package holds the terminal's shared chrome, this one holds the React primitives every cockpit
surface is built from, on the same Doom One palette.

The primitives are [shadcn/ui](https://ui.shadcn.com) components on [Radix](https://www.radix-ui.com)
(the unified `radix-ui` package), restyled with Tailwind utilities that name theme tokens only.
Because every colour is a token, a theme config recolours the whole cockpit at runtime.

## What it ships

| Export            | Components                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.`               | Actions and chips: `Button`, `Badge`, `StatusBadge`, `Dot`, `Kbd`, `NavTab*`, `Tabs*`. Fields: `Input`, `Textarea`, `Label`, `Checkbox`, `Switch`, `RadioGroup*`, `Select*`. Overlays: `Dialog*`, `Sheet*`, `Popover*`, `DropdownMenu*`, `Tooltip*`, `Toast*`, `Command*`. Layout and content: `Panel*`, `SectionLabel`, `Separator`, `EmptyState`, `ScrollArea`, `Collapsible*`, `Accordion*`, `OptionList`, `OptionRow`, `MessageItem*`, `MessageLines`. Feedback: `Spinner`, `Progress`, `Skeleton`, `Avatar*`, `StreamCursor`. Files: `CodeEditor`, `MediaPreview`. Plus the curated icon set, `cn`, `collapseLines`, `grammarKeyOf`, `mediaKindOf`, the option-list key helpers, and the tone vocabularies with the maps between them |
| `./theme`         | `ThemeConfig`, the token lists, `BUILTIN_THEMES`, `applyTheme`, `parseThemeConfig`, `themeFromPiTheme`, the stored-preference helpers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `./styles.css`    | The token stylesheet: `:root` defaults, the Tailwind `@theme inline` mapping, shadcn semantic aliases, base styles, and the `@source` for this package's classes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `./themes/*.json` | The shipped theme configs: `doom-one-dark` (default), `doom-one-light`, `doom-nord-dark`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Using it from the cockpit host

```css
/* src/web/styles/app.css */
@import 'tailwindcss';
@import '@agimon-ai/doompi-web-components/styles.css';
```

```tsx
import { Button, Dialog, DialogContent, StatusBadge } from '@agimon-ai/doompi-web-components';
import { applyTheme, builtinTheme, readThemePreference } from '@agimon-ai/doompi-web-components/theme';

applyTheme(builtinTheme(readThemePreference(localStorage) ?? 'doom-one-dark')!, document.documentElement);
```

## Tones

Three vocabularies, because they answer different questions. A **chip tone** names a colour
(`blue`, `violet`, `teal`), a **status tone** names an outcome (`running`, `ok`, `error`, `info`,
`accent`, `neutral`), and a **line tone** names a role inside a body of text (`success`, `warning`,
`muted`). They live in `src/types/tone.ts`, and `STATUS_TO_CHIP`, `STATUS_TO_DOT`, `CHIP_TO_STATUS`,
and `LINE_TONE_TO_STATUS` translate between them.

Reach for a map rather than writing another `Record<Tone, string>`: a surface that spells its own
state-to-colour table is how the same status ends up yellow in one panel and orange in the next.
Every tone table in this package is checked against these unions at compile time, so a tone added to
one and not the others fails the build.

## Tool messages

A tool call's timeline item is a `message` renderer in the plugin that registers the tool, composed
from `MessageItem` (the frame, its outcome tone, and the expand state), `MessageItemHeader` (the
tool name, the summary, the status badge, and the toggle when the item is expandable),
`MessageItemBody`, `MessageItemStatus` (the `◐ running` / `✗ failed` / `✓ done` line, or the "N
more line(s)" hint that expands), and `MessageLines` (toned lines a pure view helper computed) with
`collapseLines` for the clip. The cockpit's own fallback item is built from the same parts, which
is what keeps host and plugin items alike, and the shell carries the `tool-status` and
`tool-expand` test ids every card inherits.

## Files

`CodeEditor` is CodeMirror 6 on the doom palette: line numbers, folding, undo, a search panel, and
a grammar chosen from the file's path. It arrives as its own chunk, and each grammar as another, so
a session that never opens a file downloads neither. Give it a height (it fills its container) and
read edits back through `onChange`; `onSelect` reports the current range with one-based line
numbers, which is what anchors a review comment to a line.

```tsx
<CodeEditor value={source} path="src/app.ts" onChange={setSource} className="h-full" />
```

`MediaPreview` shows a file the browser can render but not edit: an image, a video, or a PDF from a
URL a server is already serving, and a download link for everything else. `mediaKindOf(path)` is
the same classification on its own, for a caller deciding between the editor and the preview.

Neither converts a format. A `.docx` rendered as HTML is a different document, so it is offered as
a download rather than as something that looks editable.

## Using it from a plugin's `web/` client

A web plugin's client code may import `react`, the `@tanstack` store packages,
`@agimon-ai/doompi-web-contracts`, and this package. Declare it as a `workspace:*` dependency and
import the same way the host does; the cockpit bundler dedupes it so one copy renders everywhere.
Do not import `radix-ui` or `class-variance-authority` directly from plugin code: the doom-web
vibe-lint rules route every primitive through this package so a theme change reaches all of them.

## Theme tokens

The palette a theme must supply: `bg`, `rail`, `panel`, `deep`, `border`, `border-soft`, `hi`,
`text`, `dim`, `faint`, `blue`, `green`, `yellow`, `red`, `magenta`, `violet`, `cyan`, `orange`,
`teal`, `selected`. The derived tokens (`tint-<accent>`, `edge-<accent>`, `font-mono`) are computed
from the palette with `color-mix()` unless the theme pins them; the shipped dark theme pins the exact
mockup values.

Each token is published as `--doom-<token>` on the root element and mapped to Tailwind as
`doom-<token>` (`bg-doom-panel`, `text-doom-hi`, `border-doom-edge-red`), and to shadcn's semantic
names (`bg-background`, `text-muted-foreground`, `border-input`).

## Writing a theme

```json
{
  "name": "my-theme",
  "label": "My theme",
  "scheme": "dark",
  "tokens": { "bg": "#1e1e2e", "rail": "#181825", "panel": "#1e1e2e", "deep": "#11111b", "...": "..." }
}
```

`parseThemeConfig(json)` validates it (null on any problem, so a bad file never takes the page
down) and `applyTheme(theme, document.documentElement)` writes it. `themeFromPiTheme(piThemeJson)`
builds a web theme from a Pi TUI theme, so the palette DoomPi ships for the terminal drives the
browser too.

## Development

```bash
pnpm build      # tsdown: one entry per src/exports module, ESM and CJS, browser platform
pnpm test       # theme, bridge, and render smoke tests (react-dom/server, no DOM needed)
pnpm typecheck
```

The `doom-web` vibe-lint preset governs the layout: `src/types` (the theme contract), `src/lib`
(`cn`), `src/theme`, `src/icons`, `src/components` (one PascalCase component per file, props-driven,
no application state), and `src/exports` (pure re-exports, one file per subpath).
