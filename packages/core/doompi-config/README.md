# @agimon-ai/doompi-config

Typed runtime configuration and immutable session context for
[DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi).

This package is fixed core in the DoomPi distribution. It loads `config.yaml`, validates supported
runtime settings, publishes the `doom/config` Cordis service, and maintains selection state shared
by the major-mode, domain, and profile transition flows.

> **Alpha:** configuration contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.4 as a peer dependency

## Install

```bash
npm install @agimon-ai/doompi-config
```

Do not add this package to a DoomPi layer. The distribution activates it before selectable packages
so the rest of the parent session can consume one resolved configuration snapshot.

## Runtime configuration

DoomPi reads `~/.pi/.doom/config.yaml` first and `<repoRoot>/.doom/config.yaml` second. Merge policy
is field-specific because some settings are personal and others are repository policy:

| Setting             | Effective source policy                                              |
| ------------------- | -------------------------------------------------------------------- |
| `projectTrust`      | Repository value, defaulting to `ask`                                |
| `editor`            | Personal config only                                                 |
| `modes.planning`    | Personal and repository fields merge, with repository values winning |
| `voice`             | Personal and repository fields merge, with repository values winning |
| `voice.autoCapture` | Personal config only                                                 |
| `selection`         | Per-axis merge, with repository values winning                       |

Supported root keys are `modes`, `projectTrust`, `editor`, `voice`, and `selection`. Unknown keys and
invalid values fail during loading.

```yaml
projectTrust: ask
modes:
  planning:
    main:
      model: openai/gpt-5.4
      thinking: high
    plansDirectory: .doom/plans
voice:
  engine: auto
  language: en
selection:
  majorMode: copilot
  domains: [default]
  profile: reviewer
```

The `selection` mapping names defaults. Definitions for those axes live in `modes.yaml`,
`domains.yaml`, and `profiles.yaml` and are documented by their owning package Help skills.

See the shipped [configuration contract](./src/prompts/doompi-author-config/references/config-contract.md) for
the complete runtime schema and additional configuration details.

## Typed session context

`@agimon-ai/doompi-config/extensions/pi` joins the runner-scoped Cordis host and provides
`DOOM_CONFIG_SERVICE`. Consumers must access it under an owning service injection:

```ts
import { DOOM_CONFIG_SERVICE, type DoomConfigContext, requireDoomConfigContext } from '@agimon-ai/doompi-config';
import type { Context } from '@deepseek-ai/cordis';

export function consumeDoomConfig(context: Context, consume: (snapshot: DoomConfigContext) => void): void {
  context.inject([DOOM_CONFIG_SERVICE], (configContext) => {
    consume(requireDoomConfigContext(configContext));
  });
}
```

The snapshot is deeply frozen. It contains validated `settings`, active `harness` state, an optional
`pendingSelection`, and `requiresRelaunch`. Do not mutate it or retain it across provider or session
replacement. The next session publishes a new snapshot.

## Selection transitions

Major-mode, domain, and profile packages resolve their own requested changes, then use the shared
transition coordinator. Config owns the persisted selection and transition journal records used to
distinguish active state from pending intent.

Transitions are serialized and compared with the active composition fingerprint. A compatible
change can use Pi reload. A launcher-owned composition change records pending intent for process
relaunch. A fresh session acknowledges a pending transition only when its exact target selection and
composition are active.

Consumers must not edit `snapshot.harness`, bypass the coordinator, or cache launcher environment
state at module scope.

## Public API

The root and focused `/config` and `/piContext` exports provide runtime parsing, merge policy, and
session integration:

```ts
import { loadDoomConfig } from '@agimon-ai/doompi-config';

const settings = loadDoomConfig(process.cwd());
```

The package also exposes lower-level loaders used by the fixed axis packages. User-facing guidance
for defining modes, domains, and profiles is intentionally owned by those packages instead of this
runtime Config authoring skill.

## Help

The package publishes `src/prompts/doompi-author-config`, links it from `llms.txt`, and registers
`doompi-author-config` with the `doom/help` Cordis service. The guidance is visible to the AI only
while the parent Help minor mode is active.

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
