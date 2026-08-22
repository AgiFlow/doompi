import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  connectionDispose: vi.fn(async () => undefined),
  fiberDispose: vi.fn(async () => undefined),
  plugin: vi.fn(),
}));

vi.mock('@agimon-ai/doompi-extension-contracts/cordis-host', () => ({
  connectDoomCordisHost: hostMocks.connect,
}));

const { activateDoomPiReadExtension } = await import('../src/adapters/pi/extension.ts');

function createPi(): {
  readonly pi: ExtensionAPI;
  readonly shutdown: () => unknown;
} {
  const handlers = new Map<string, () => unknown>();
  const pi = {
    on: vi.fn((event: string, handler: () => unknown) => handlers.set(event, handler)),
  } as unknown as ExtensionAPI;
  return {
    pi,
    shutdown() {
      const handler = handlers.get('session_shutdown');
      if (!handler) throw new Error('Missing session_shutdown handler');
      return handler();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const fiber = Object.assign(Promise.resolve(), { dispose: hostMocks.fiberDispose });
  hostMocks.plugin.mockReturnValue(fiber);
  hostMocks.connect.mockResolvedValue({
    root: { plugin: hostMocks.plugin },
    runtime: { abiVersion: 1, generation: 'test', hostId: 'test', mode: 'composed' },
    dispose: hostMocks.connectionDispose,
  });
});

describe('standard doompi-read extension lifecycle', () => {
  it('acquires one host lease, mounts one root fiber, and releases both once on repeated shutdown', async () => {
    const fixture = createPi();
    await activateDoomPiReadExtension(fixture.pi);

    expect(hostMocks.connect).toHaveBeenCalledOnce();
    expect(hostMocks.connect).toHaveBeenCalledWith(fixture.pi, '@agimon-ai/doompi-read');
    expect(hostMocks.plugin).toHaveBeenCalledOnce();

    await Promise.all([Promise.resolve(fixture.shutdown()), Promise.resolve(fixture.shutdown())]);
    expect(hostMocks.fiberDispose).toHaveBeenCalledOnce();
    expect(hostMocks.connectionDispose).toHaveBeenCalledOnce();
    expect(hostMocks.fiberDispose.mock.invocationCallOrder[0]).toBeLessThan(
      hostMocks.connectionDispose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
