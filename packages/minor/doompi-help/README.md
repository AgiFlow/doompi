# @agimon-ai/doompi-help

Load package-owned DoomPi guidance only when Help mode is active.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Packages contribute concise `llms.txt` indexes. Help keeps them out of the default model context and exposes them only while Help mode is active.

> **Alpha:** Help contribution contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.4

## Install

DoomPi includes Help in every parent and detached-child composition. No layer declaration is
required. To load the package directly in Pi:

```bash
pi install npm:@agimon-ai/doompi-help
```

Pi loads the package through `@agimon-ai/doompi-help/extensions/pi`. DoomPi and standalone Pi use
the same extension.

## Activate and deactivate

In an interactive DoomPi session, use `SPC h e`. Headless DoomPi clients invoke the Help action
through the shared minor-mode catalog service. In standalone Pi, run `/doom-help`; the command does
not require Doom config or Leader Space.

Activation resolves each contributor in this order:

1. its published `llms.txt`;
2. an immutable exact-version cache;
3. a verified exact-version unpkg fallback.

Deactivation withdraws the active Help skills before the next prompt or catalog read. Cached
package content or previously generated wrappers may remain on disk, but they are no longer active
model context.

The package contributes `doompi-use-help`. A standard parent catalog can compose two groups from
the packages that are present:

- **How to author:** extension, Config, Major Mode, Domain, Profile, Hook, Workflow, and Skill
  guidance under explicit `doompi-author-*` names.
- **How to use:** Help, Voice, Plan, Goal, Loop, Workflow, Runner, MCP, and Skill guidance under
  explicit `doompi-use-*` names.

Each owning package registers its descriptors and exact package index through the shared Help
service. Missing or inactive packages do not leave placeholder skills in the catalog.

## Parent and child behavior

Parent and child sessions load the same distribution-default extension. Replacing a session removes
the previous Help service, its contributions, and its UI and mode integrations before activating
the replacement.

Root and axis authoring guidance is parent-only when those packages are absent from detached-child
composition. Config and selected child features can still contribute package guidance to a
detached child.

## Public API

```ts
import { helpExtension, installHelpRuntime } from '@agimon-ai/doompi-help';
```

The root export is intended for host integrations and tests. Users activate Help through the normal
extension.

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
