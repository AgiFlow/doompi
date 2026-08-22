import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

const installTeamRuntime = vi.hoisted(() => vi.fn());
const fiberDispose = vi.hoisted(() => vi.fn(async () => undefined));
const connectionDispose = vi.hoisted(() => vi.fn(async () => undefined));
const plugin = vi.hoisted(() =>
  vi.fn((activate: (cordis: unknown, config: unknown) => void, config: unknown) => {
    activate({ effect: vi.fn() }, config);
    return { dispose: fiberDispose };
  }),
);
vi.mock('../../src/adapters/pi/extension.ts', () => ({ installTeamRuntime }));
vi.mock('@agimon-ai/doompi-extension-contracts/cordis-host', () => ({
  connectDoomCordisHost: vi.fn(async () => ({
    root: { plugin },
    dispose: connectionDispose,
  })),
}));

const { activateTeamExtension } = await import('../../src/adapters/pi/standard');

describe('standard Team composition', () => {
  it('mounts the complete Team runtime in a host-owned plugin fiber', async () => {
    const handlers = new Map<string, () => Promise<void>>();
    const pi = {
      on(event: string, handler: () => Promise<void>) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    await activateTeamExtension(pi);

    expect(installTeamRuntime).toHaveBeenCalledWith(expect.anything(), pi);
    await expect(handlers.get('session_shutdown')?.()).resolves.toBeUndefined();
    await expect(handlers.get('session_shutdown')?.()).resolves.toBeUndefined();
    expect(fiberDispose).toHaveBeenCalledOnce();
    expect(connectionDispose).toHaveBeenCalledOnce();
  });
});
