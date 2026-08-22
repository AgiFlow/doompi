import {
  DOOM_BACKGROUND_WORK_SERVICE,
  type BackgroundWorkProvider,
  type DoomBackgroundWorkService,
} from '@agimon-ai/doompi-extension-contracts/background-work';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it } from 'vitest';

import { registerRunProvider } from '../../src/services/backgroundWork.ts';

const roots: Context[] = [];

function service(generation: string): {
  readonly value: DoomBackgroundWorkService;
  readonly providers: Map<string, BackgroundWorkProvider>;
} {
  const providers = new Map<string, BackgroundWorkProvider>();
  return {
    providers,
    value: {
      generation,
      register(provider) {
        providers.set(provider.provider, provider);
        let disposed = false;
        return {
          provider: provider.provider,
          generation: `${generation}:${provider.provider}`,
          update: () => undefined,
          dispose() {
            if (disposed) return;
            disposed = true;
            if (providers.get(provider.provider) === provider) providers.delete(provider.provider);
          },
        };
      },
      snapshot(sessionId) {
        return {
          items: [...providers.values()].flatMap((provider) =>
            provider
              .listActiveWork()
              .filter((item) => sessionId === undefined || item.sessionId === sessionId)
              .map((item) => ({ provider: provider.provider, ...item })),
          ),
          errors: [],
        };
      },
    },
  };
}

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe('Workflow background-work binding', () => {
  it('rebinds the current snapshot when the Team provider unloads and returns', async () => {
    const root = new Context();
    roots.push(root);
    const handle = registerRunProvider(root);
    handle.update([{ id: 'run-1', sessionId: 'session-1' }]);

    const first = service('first');
    const firstFiber = root.plugin((ctx) => ctx.provide(DOOM_BACKGROUND_WORK_SERVICE, first.value));
    await firstFiber;
    expect(first.value.snapshot('session-1').items).toEqual([
      { provider: 'workflow-mcp', id: 'run-1', sessionId: 'session-1' },
    ]);

    await firstFiber.dispose();
    expect(first.providers.size).toBe(0);

    const second = service('second');
    const secondFiber = root.plugin((ctx) => ctx.provide(DOOM_BACKGROUND_WORK_SERVICE, second.value));
    await secondFiber;
    expect(second.value.snapshot('session-1').items).toEqual([
      { provider: 'workflow-mcp', id: 'run-1', sessionId: 'session-1' },
    ]);

    handle.dispose();
    expect(second.providers.size).toBe(0);
  });
});
