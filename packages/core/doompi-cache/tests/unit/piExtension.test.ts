import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const optimizer = vi.fn();
  return {
    order: [] as string[],
    optimizer,
    optimizerExport: optimizer as unknown,
    mount: vi.fn(),
    factory: vi.fn(),
    dispose: vi.fn(),
  };
});
vi.mock('../../src/services/cacheRuntime', () => ({
  createCacheRuntime: (...args: unknown[]) => {
    mocks.order.push('cache');
    mocks.mount(...args);
    return { plugin: () => {}, events: {}, dispose: mocks.dispose };
  },
}));
vi.mock('../../src/services/promptCacheTelemetry', () => ({ PromptCacheTelemetryService: vi.fn() }));
vi.mock('#doompi-cache-optimizer-source', () => ({
  get default() {
    return mocks.optimizerExport;
  },
}));
vi.mock('@agimon-ai/doompi-core/pi-extension', () => ({
  definePiExtension: (_name: string, factory: (...args: unknown[]) => unknown) => {
    mocks.factory.mockImplementation(factory);
    return (pi: ExtensionAPI, options?: unknown) => factory({ pi, options });
  },
}));
import { extension as activateCacheExtension } from '../../generated/pi';
import { PromptCacheTelemetry } from '../../src/models/promptCacheTelemetry';

const pi = {} as ExtensionAPI;
afterEach(() => {
  mocks.optimizer.mockReset();
  mocks.optimizerExport = mocks.optimizer;
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
    const activation = activateCacheExtension(pi);
    await vi.waitFor(() => expect(mocks.optimizer).toHaveBeenCalledWith(pi));
    expect(mocks.mount).not.toHaveBeenCalled();
    ready();
    await activation;
    expect(mocks.order).toEqual(['optimizer', 'cache']);
    expect(mocks.mount).toHaveBeenCalledWith(
      expect.objectContaining({ now: Date.now }),
      expect.objectContaining({ default: mocks.optimizer }),
    );
  });
  it('passes the caller telemetry and clock to the declaration', async () => {
    const dependencies = { telemetry: new PromptCacheTelemetry(), now: () => 123 };
    await activateCacheExtension(pi, dependencies);
    expect(mocks.mount).toHaveBeenCalledWith(dependencies, expect.objectContaining({ default: mocks.optimizer }));
  });
  it('cleans up runtime state through the lifecycle after registrations are removed', async () => {
    const declaration = (await mocks.factory({
      pi,
      options: { telemetry: new PromptCacheTelemetry(), now: Date.now },
    })) as { onDispose(): void };
    declaration.onDispose();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it('does not mount cache hooks when optimizer startup fails', async () => {
    const failure = new Error('optimizer startup');
    mocks.optimizer.mockRejectedValue(failure);
    await expect(activateCacheExtension(pi)).rejects.toBe(failure);
    expect(mocks.mount).not.toHaveBeenCalled();
  });

  it('rejects an optimizer module without an extension factory', async () => {
    mocks.optimizerExport = undefined;
    await expect(activateCacheExtension(pi)).rejects.toThrow('does not export an extension factory');
    expect(mocks.mount).not.toHaveBeenCalled();
  });
});
