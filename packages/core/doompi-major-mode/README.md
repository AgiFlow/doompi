# @agimon-ai/doompi-major-mode

Named major-mode selection for [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) sessions.

A **major mode** is one of the four axes of a DoomPi selection, alongside domains, the profile,
and the minor modes. It names an ordered list of layers, and each layer names the packages it
activates:

```yaml
# .doom/modes.yaml
layers:
  team:
    packages: ['@agimon-ai/doompi-team']
  ask-user:
    packages: ['@agimon-ai/doompi-user-feedback']
  task:
    packages: ['@agimon-ai/doompi-task']

majorMode:
  minimal:
    description: Lean mode with Team delegation and persistent tasks.
    layers: [team, task]
  copilot:
    description: General coding with delegation, persistent tasks, and structured user feedback.
    layers: [team, ask-user, task]
```

Default packages load before these layers. The `layers` array is authored activation order, not a
set.

## What it registers

| Surface                 | Behavior                                                                   |
| ----------------------- | -------------------------------------------------------------------------- |
| `/mode`                 | picks a major mode, applies it, and reloads                                |
| `major_mode` voice tool | `list` returns every mode with its purpose and layers; `switch` queues one |
| status line             | `*profile*:[major-mode]:domains`, amber while a switch is pending          |
| Help contribution       | exposes focused `modes.yaml` guidance while DoomPi Help is active          |

## Help guidance

This package registers `doompi-author-major-mode` with the session-local `doom/help` Cordis
service. Registration is inert until `@agimon-ai/doompi-help` is active. Once active, the Help
skill routes the AI through this package's validated [`llms.txt`](./llms.txt) index.

The package owns both the concise [major-mode authoring prompt](./src/prompts/doompi-author-major-mode/SKILL.md)
and the detailed [`modes.yaml` contract](./src/prompts/doompi-author-major-mode/references/modes-contract.md),
so the guidance is versioned with the parser and runtime that consume it.

## Switching, and why it is not always a reload

A major-mode change alters which extensions load, and Pi freezes the CLI `--extension` list at
construction. So the disposition depends on how the session started:

- **synchronized** (`dpi`, or regular `pi` after `doompi sync`): the session composes its own
  extension set on every load, so the new layers arrive with a `pi-reload`. If the target
  composition has no synchronized bundle yet, the transition reports `sync-required` and asks for
  `doompi sync`.
- **launcher**: the extension closure is fixed, so a mode whose layers differ needs a new process.
  The switch is journaled as pending and the command prints the relaunch line rather than
  pretending it applied.

Either way the change is planned through the session's transition coordinator first, and active
minor modes are captured before the reload and restored after it. A failed apply rolls the harness
state back from a snapshot and journals the transition as aborted.

The voice tool never applies a switch itself. It mints an opaque handoff token and sends
`/mode --voice-switch-token=…` back as a follow-up, so the reload happens inside a command handler
where it can be the terminal action.

## Installation

DoomPi depends on this package and activates it as fixed host core, so a DoomPi install already has
it. It is not selectable from `.doom/modes.yaml`. It is what reads that file.

## License

MIT
