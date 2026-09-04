# @agimon-ai/doompi-loop

Send a prompt now, then repeat it at a bounded interval for the current session.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Several loops can coexist. Loop is a minor mode and remains active while at least one scheduled
prompt belongs to the current session.

> **Alpha:** launcher and scheduling contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.85.0 and Pi TUI 0.85.0

## Install

DoomPi includes Loop in every composition. Pi loads it through package extension metadata. For
standalone Pi:

```bash
pi install npm:@agimon-ai/doompi-loop
```

## Start and manage loops

Use `/loop` to start a loop and `/loops` to inspect or stop active loops. In DoomPi, `SPC l s` opens
the start flow and `SPC l l` opens the list.

The default interval is 300 seconds. Accepted intervals range from 30 to 3600 seconds. A loop runs
its prompt once immediately, then schedules later passes.

If Pi is busy, a due pass waits for the shared agent to become idle. Multiple due signals can
coalesce rather than creating overlapping model turns. Stopping a loop prevents future passes but
does not rewind side effects from a pass already sent.

## Lifecycle and cost

Loop state belongs to the session's `doom/loop-launchers` service; it is not a durable queue.
Replacing or shutting down the session aborts pending launches and stops active timers. Resuming a
transcript does not restart old loops.

Every pass can start another model turn and repeat tool or external side effects. Choose
conservative intervals, make prompts idempotent where possible, and stop loops when the recurring
work is complete.

## Extension authors: cross-extension launchers

Launcher definitions use the shared Cordis service. A consumer registers a launcher and returns its
cleanup callback. Cordis removes that launcher when either package or the session unloads, then
registers it again when the provider returns.

```ts
import {
  DOOM_LOOP_LAUNCHERS_SERVICE,
  requireDoomLoopLaunchers,
} from '@agimon-ai/doompi-extension-contracts/loop-launchers';
import type { Context } from '@deepseek-ai/cordis';

export function myLoopPlugin(ctx: Context): void {
  ctx.inject([DOOM_LOOP_LAUNCHERS_SERVICE], (sessionContext) => {
    const registration = requireDoomLoopLaunchers(sessionContext).register({
      id: 'example.recurring-check',
      source: '@example/doompi-recurring-check',
      label: 'Recurring check',
      async launch({ instanceId, signal }) {
        signal.throwIfAborted();
        // Start session work. The returned stop callback owns cleanup.
        return { instanceId, stop: () => undefined };
      },
    });
    return () => registration.dispose('Contributor unloaded.');
  });
}
```

Mount that plugin on the runner's shared Doom Cordis root. Loop owns the registry and default
launcher. Consumers depend only on
`@agimon-ai/doompi-extension-contracts/loop-launchers`; there is no process-global registry or
session-ID lookup API.

The package root exports `installLoopRuntime` for composition tests, plus the service contract
types. Normal Pi activation uses the discovered `extensions/pi` entry.

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
