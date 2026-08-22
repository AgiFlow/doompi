import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cordisRoots: Context[] = [];

vi.mock('@agimon-ai/doompi-extension-contracts/cordis-host', () => ({
  connectDoomCordisHost: async () => {
    const root = new Context();
    cordisRoots.push(root);
    return {
      root,
      runtime: { abiVersion: 1, generation: 'log-headless-test', hostId: 'log-headless-test', mode: 'standalone' },
      dispose: async () => undefined,
    };
  },
}));

afterEach(async () => {
  await Promise.allSettled(cordisRoots.splice(0).map((root) => root.fiber.dispose()));
  vi.clearAllMocks();
});

describe('doom-log headless entry', () => {
  it('loads and registers when the optional UI provider is unavailable', async () => {
    const { default: register } = await import('../src/exports/extensions/pi.ts');
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
    };

    await expect(register(pi as never)).resolves.toBeUndefined();
    expect(pi.registerCommand).toHaveBeenCalledWith('log-metrics', expect.any(Object));
  });
});
