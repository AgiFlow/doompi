import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionWebComposition } from '../../src/types/hub';

const worker = vi.hoisted(() => ({
  bundle: vi.fn(),
  plugins: vi.fn(),
}));
vi.mock('../../src/pwa/workerClient', () => ({
  activateVerifiedBundle: worker.bundle,
  activateVerifiedPluginComposition: worker.plugins,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

function fixture(controller: object | null = {}) {
  const serviceWorker = {
    controller,
    register: vi.fn(async () => undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('navigator', { serviceWorker });
  worker.bundle.mockResolvedValue({ ok: true });
  worker.plugins.mockResolvedValue({ ok: true });
  const composition = { verifiedAssetBaseUrl: '/verified/' } as SessionWebComposition;
  return { serviceWorker, composition };
}

describe('verified development composition', () => {
  it('shares key activation across compositions and uses verified asset URLs', async () => {
    const { composition } = fixture();
    const { verifiedDevComposition } = await import('../../src/web/lib/verifiedDevComposition');
    const first = await verifiedDevComposition(composition, 'key');
    await verifiedDevComposition(composition, 'key');
    expect(worker.bundle).toHaveBeenCalledOnce();
    expect(worker.plugins).toHaveBeenCalledTimes(2);
    expect(first.url('entry.js')).toBe('/verified/entry.js');
    first.close();
    await verifiedDevComposition(composition, 'replacement');
    expect(worker.bundle).toHaveBeenCalledTimes(2);
  });

  it('allows retry after key verification fails and refuses invalid plugins', async () => {
    const { composition } = fixture();
    const { verifiedDevComposition } = await import('../../src/web/lib/verifiedDevComposition');
    worker.bundle.mockResolvedValueOnce({ ok: false, code: 'wrong-key' });
    await expect(verifiedDevComposition(composition, 'key')).rejects.toThrow('wrong-key');
    expect(worker.plugins).not.toHaveBeenCalled();
    worker.plugins.mockResolvedValueOnce({ ok: false, code: 'invalid-plugin' });
    await expect(verifiedDevComposition(composition, 'key')).rejects.toThrow('invalid-plugin');
    expect(worker.bundle).toHaveBeenCalledTimes(2);
  });

  it('waits for worker control before loading plugins and times out cleanly', async () => {
    vi.useFakeTimers();
    const { composition, serviceWorker } = fixture(null);
    const { verifiedDevComposition } = await import('../../src/web/lib/verifiedDevComposition');
    const ready = verifiedDevComposition(composition, 'key');
    const rejected = expect(ready).rejects.toThrow('did not take control');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(serviceWorker.removeEventListener).toHaveBeenCalledWith('controllerchange', expect.any(Function));
    expect(worker.plugins).not.toHaveBeenCalled();
  });
});
