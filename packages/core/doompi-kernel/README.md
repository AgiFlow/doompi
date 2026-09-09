# @agimon-ai/doompi-kernel

Layer-gated contribution registry that recomposes a DoomPi host surface without a reload.

This is a foundation library, not a Pi extension. It has no `pi.extensions` entry, Cordis service,
or Pi peer dependency, and it imports nothing. The Pi facet and the headless server facet share one
registry because neither host type appears here.

## The problem it solves

A DoomPi session changes shape on four axes: major mode, minor modes, profile and domains. Switching
an axis used to mean rebuilding the host, and rebuilding the host meant losing whatever the session
held in memory. The kernel makes a switch a recompute instead.

## Slots

Everything a host exposes is a slot: tools, commands, resources, hooks. A slot has one sink, and the
sink always receives the complete active list. Whole-list replacement is what makes removal
inherent, so nothing has to be individually unregistered.

```ts
import { createDoomKernel } from '@agimon-ai/doompi-kernel';

const kernel = createDoomKernel({ activeLayers: ['team', 'plan'] });
const tools = kernel.defineSlot<Tool>('tools', (active) => host.setTools([...active]));

tools.contribute({ source: '@agimon-ai/doompi-team', layer: 'team', value: delegateTool });
tools.contribute({ source: '@agimon-ai/doompi', value: alwaysOnTool });
```

A contribution with no `layer` is never gated. One with a `layer` applies only while that layer is
active, which is how a major mode selects a surface:

```ts
await kernel.setActiveLayers(resolveLayers(config, 'minimal'));
```

`refresh(slot)` re-pushes a slot whose values render differently without the list changing, which is
what a domain change does to resources.

## Behaviour worth knowing

- Registrations coalesce into one push per slot, so composing forty packages costs one apply each.
- A slot whose active list is unchanged is not pushed. Hosts treat a set call as a structural
  change, and a redundant one is visible to the user.
- Overlapping `setActiveLayers` calls coalesce. A host converges on the last layer set rather than
  replaying each one, so tapping through modes costs one apply.
- One throwing sink does not stop the others. `refresh` rejects afterwards naming every failure.
- Contribution order is registration order, and it is stable across recomputes.
