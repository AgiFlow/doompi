# @agimon-ai/doompi-prompt

Staged recent prompts and saved prompt templates for DoomPi

This package is a composable [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) subsystem. Use it with the distribution or install it independently in [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

## Requirements

- Node.js 22.19.0 or newer
- `@earendil-works/pi-coding-agent` 0.85.0

## Install

```bash
pi install npm:@agimon-ai/doompi-prompt
```

The package declares its Pi extension entry, so Pi loads it after installation. DoomPi users can include the package through their normal profile and domain composition instead.

## Use

Run the registered command in Pi:

```text
/prompts
```

Browse the last three prompts of this session and every saved prompt, then stage one in the editor.

## Package behavior

Two commands, and no history file:

```text
/prompts              Pick a staged or saved prompt and stage it in the editor (also SPC e p)
/prompt-save review   Save the current draft as ~/.pi/agent/prompts/review.md
```

The last three prompts you submit are held in memory for the session only, and nothing is written
to disk unless you run `/prompt-save`. Saving writes an ordinary Pi prompt template:

```markdown
---
description: 'Review the staged diff'
---

Review the staged diff and report bugs, security issues and error handling gaps.
```

Because it is a plain template, Pi also exposes it as `/review` from the next start, with the usual
`$1` and `$@` argument substitution. The picker reads the directory directly, so a prompt saved a
minute ago is already listed in the current session.

Arrow up and down are untouched: they remain Pi's own in-session history. To recall regardless of
cursor position, bind `tui.editor.historyPrevious` and `tui.editor.historyNext` in
`~/.pi/agent/keybindings.json`.

## Cockpit

The package contributes a `prompts` group to the cockpit's activity dock, next to agents, runners
and workflows, backed by a hub-scoped API at `/api/plugin/prompts`. The group reports how many
prompts are saved and offers `send a prompt`, which opens a dialog over the conversation. Picking
one sends it to the focused session; the same dialog creates, edits, renames and deletes entries.

| Route                   | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `GET /prompts`          | Every saved prompt, sorted by name                                  |
| `PUT /prompts/:name`    | Create or replace one, deriving its description from the first line |
| `DELETE /prompts/:name` | Remove one                                                          |

The API is hub-scoped because saved prompts belong to the agent directory rather than to a session.
Staged prompts are not exposed there: they live in the memory of the session that received them.

In RPC hosts such as the cockpit, Pi reports an empty editor draft, so `/prompt-save` run from the
cockpit composer saves the newest staged prompt rather than the text being typed. Save from the
dialog instead.

The cockpit hub mounts package APIs from the route table `doompi sync` generates. After installing
or changing this package, run a build and `doompi sync`, then restart the hub, or its routes answer 404.

## Help

The published package includes `llms.txt` and the package-owned `src/prompts/doompi-use-prompt/SKILL.md`. When the DoomPi Help minor mode is active, the extension contributes `doompi-use-prompt` to its live Help catalog. The contribution follows Help provider replacement and is withdrawn when the extension shuts down.

Help remains optional. Loading the standalone Pi extension does not require DoomPi Help or any other DoomPi runtime service.

To add another package-owned Help prompt, use the `scaffold-doom-prompt` feature with a `doompi-author-*` or `doompi-use-*` name and a concise description. Then link the generated `SKILL.md` from `llms.txt` and register a matching descriptor through the optional `DOOM_HELP_SERVICE` injection in the Pi adapter. Keep prompts as published resources under `src/prompts`; do not export them or copy them into `dist`.

## Public API

```ts
import { activatePromptExtension, createNodeSavedPromptStore, createRecentPrompts } from '@agimon-ai/doompi-prompt';
```

The Pi host entry is also available at:

```text
@agimon-ai/doompi-prompt/extensions/pi
```

The service layer is host-neutral. The Pi entrypoint owns only command registration and its runtime-scoped installation guard.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm exec vibe-lint check .
npm pack --dry-run
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
