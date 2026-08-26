# @agimon-ai/doompi-file-edit

A session-scoped file-change timeline and external-editor launcher for Pi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

The package records files changed by successful `edit` and `write` calls and literal file paths
detected in successful Bash changes. It presents the current session's work without relying on the
transcript to remember every path.

> **Alpha:** timeline and UI contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.3 and Pi TUI 0.84.3
- Git for diffs against `HEAD`

## Install

DoomPi includes File Edit in every composition. Standalone Pi loads the same extension:

```bash
pi install npm:@agimon-ai/doompi-file-edit
```

| Entry                                       | Purpose                             |
| ------------------------------------------- | ----------------------------------- |
| `@agimon-ai/doompi-file-edit/extensions/pi` | Timeline and DoomPi Leader shortcut |
| `@agimon-ai/doompi-file-edit`               | Library API                         |

## Open the timeline

Use `SPC e f` in DoomPi. Select a file to inspect its diff or open it in the configured editor.

Diffs compare the working tree with Git `HEAD` and are capped at 200 lines and 256 KiB. Files outside
Git history or changes that cannot be attributed to a literal Bash path may have limited timeline
detail.

The overlay and external-editor handoff require an interactive TUI. Headless hosts can consume the
timeline services but cannot display the panel.

## Configure the editor

Set the shared DoomPi configuration in `~/.pi/.doom/config.yaml`:

```yaml
editor:
  command: nvim +{line} {file}
```

For a standalone installation, the package falls back to
`~/.pi/agent/doom-file-edit/config.yaml`. Resolution order is:

1. DoomPi `editor.command`;
2. package fallback configuration;
3. `$VISUAL`;
4. `$EDITOR`;
5. `nano {file}` on Unix-like systems.

Only `{file}` and `{line}` placeholders are expanded. The command is split and spawned directly,
not passed through a shell, so shell operators and expansions are not interpreted.

## Data behavior

The timeline contains file paths and Git-derived diff content from the current session. That content
can be sensitive. It is stored in session-scoped package state and should be protected with the
same access controls as Pi session data.

## Public API

```ts
import { createFileEditContainer, fileEditExtension } from '@agimon-ai/doompi-file-edit';
import type { FileDiff, FileEditEntry } from '@agimon-ai/doompi-file-edit';
```

The root also exports editor-resolution and timeline domain types for host integrations.

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
