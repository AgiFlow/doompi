import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  optimizer: vi.fn(),
  mount: vi.fn(),
  factory: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('../../src/services/cacheRuntime', () => ({
  createCacheRuntime: () => ({ plugin: () => {}, events: {}, dispose: mocks.dispose }),
}));
vi.mock('../../src/services/promptCacheTelemetry', () => ({ PromptCacheTelemetryService: vi.fn() }));
vi.mock('#doompi-cache-optimizer-source', () => ({ default: mocks.optimizer }));
vi.mock('@agimon-ai/doompi-core/pi-extension', () => ({
  definePiExtension: (_name: string, factory: (...args: unknown[]) => unknown) => {
    mocks.factory.mockImplementation(factory);
    return mocks.mount;
  },
}));
import { PromptCacheTelemetry } from '../../src/models/promptCacheTelemetry';
import { activateCacheExtension } from '../../src/extensions/pi';

const pi = {} as ExtensionAPI;
afterEach(() => {
  mocks.optimizer.mockReset();
  mocks.mount.mockReset();
  mocks.dispose.mockClear();
  mocks.order.length = 0;
});
describe('Cache activation ordering', () => {
  it('waits for the upstream optimizer before mounting the Doom cache hooks', async () => {
    let ready!: () => void;
    mocks.optimizer.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
          mocks.order.push('optimizer');
        }),
    );
    mocks.mount.mockImplementation(() => {
      mocks.order.push('cache');
    });
    const activation = activateCacheExtension(pi);
    await vi.waitFor(() => expect(mocks.optimizer).toHaveBeenCalledWith(pi));
    expect(mocks.mount).not.toHaveBeenCalled();
    ready();
    await activation;
    expect(mocks.order).toEqual(['optimizer', 'cache']);
    expect(mocks.mount).toHaveBeenCalledWith(
      pi,
      expect.objectContaining({ dependencies: expect.objectContaining({ now: Date.now }) }),
    );
  });
  it('passes the caller telemetry and clock to the declaration', async () => {
    const dependencies = { telemetry: new PromptCacheTelemetry(), now: () => 123 };
    await activateCacheExtension(pi, dependencies);
    expect(mocks.mount).toHaveBeenCalledWith(pi, expect.objectContaining({ dependencies }));
  });
  it('cleans up runtime state through the lifecycle after registrations are removed', () => {
    const declaration = mocks.factory({
      options: { dependencies: { telemetry: new PromptCacheTelemetry(), now: Date.now }, optimizer: {} },
    }) as { onDispose(): void };
    declaration.onDispose();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(() => mocks.factory({})).toThrow('Cache optimizer must be initialized');
  });
  it('does not mount cache hooks when optimizer startup fails', async () => {
    const failure = new Error('optimizer startup');
    mocks.optimizer.mockRejectedValue(failure);
    await expect(activateCacheExtension(pi)).rejects.toBe(failure);
    expect(mocks.mount).not.toHaveBeenCalled();
  });
});
