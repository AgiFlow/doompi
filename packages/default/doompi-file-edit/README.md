# @agimon-ai/doompi-file-edit

A session-scoped file-change timeline and external-editor launcher for Pi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

The package records every file the session changed and keeps enough content to diff it, without
assuming the working directory is a Git repository. `edit` and `write` name their file in the call,
so both sides of the change are captured exactly. A Bash call names nothing reliable, because the
agent can put the paths in a script, so the tree is compared either side of the call and whatever
moved is recorded however it was written.

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

| Entry                                       | Purpose                                      |
| ------------------------------------------- | -------------------------------------------- |
| `@agimon-ai/doompi-file-edit/extensions/pi` | Timeline and DoomPi Leader shortcut          |
| `@agimon-ai/doompi-file-edit/session-api`   | HTTP routes the cockpit reads a file through |
| `@agimon-ai/doompi-file-edit/web-hub`       | Hub channel publishing the changed-file list |
| `@agimon-ai/doompi-file-edit`               | Library API                                  |

## Open the timeline

Use `SPC e f` in DoomPi. Select a file to inspect its diff or open it in the configured editor.

TUI diffs compare the working tree with Git `HEAD` and are capped at 200 lines and 256 KiB. The
overlay and external-editor handoff require an interactive TUI. Headless hosts can consume the
timeline services but cannot display the panel.

## In the cockpit

The `# files` group in the activity dock lists every file the session changed. Selecting one opens a
temporary tab holding three views of it:

- **diff**: what the session did to the file, followed by each recorded change on its own, so a file
  edited four times shows four distinct diffs rather than one merged blur.
- **source**: the file as it stands, editable. Saving writes straight to disk and is refused if the
  file changed since it was opened, so a hand edit cannot silently discard what the agent wrote.
- **preview**: rendered Markdown, or HTML in a sandboxed frame.

Selecting text in any view raises a comment box. Comments queue on the tab and one **send review**
builds a single message quoting each anchor, so several comments cost one turn.

Diffs here do not use Git. The package captures the file's content before an `edit` or `write` runs
and keeps it, content-addressed, beside the session timeline; both go when the session ends.

### What this cannot see

- A file the session changed and then deleted. The dock lists things to open, so a row that can only
  answer "this is gone" is left out. The timeline still holds the change, so a tab already open on
  the file keeps working and says why it has nothing to show.
- A file changed by a background process that outlives its Bash call. The tree is compared when the
  call ends.
- A file changed outside any tool. There is no always-on watcher.
- Content past 1 MiB, and binary files. These are listed as changed, without content.
- A file found only by comparing the tree has no baseline, so it is listed, readable and editable,
  but never diffed. Rows and versions say so rather than showing an empty diff.
- The tree walk skips dependency and build directories and is capped on entries and depth, so a very
  deep or very large checkout can under-report.

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

The timeline contains file paths, and the snapshot store holds copies of the file content the
session changed. That content can be sensitive. Both live in session-scoped package state beside the
Pi agent directory, are removed when the session ends, and should be protected with the same access
controls as Pi session data.

The session API reads and writes only files the timeline already records, so a request cannot reach
a file this session never changed.

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
