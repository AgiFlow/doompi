import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const optimizer = vi.fn();
  return {
    order: [] as string[],
    optimizer,
    optimizerExport: optimizer as unknown,
    mount: vi.fn(),
    dispose: vi.fn(),
  };
});
vi.mock('../../src/services/cacheRuntime', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/cacheRuntime')>();
  return {
    createCacheRuntime: (...args: Parameters<typeof original.createCacheRuntime>) => {
      mocks.order.push('cache');
      mocks.mount(...args);
      const runtime = original.createCacheRuntime(...args);
      return {
        ...runtime,
        dispose: () => {
          mocks.dispose();
          runtime.dispose();
        },
      };
    },
  };
});
vi.mock('#doompi-cache-optimizer-source', () => ({
  get default() {
    return mocks.optimizerExport;
  },
  __internals_for_tests: {
    isRuntimeOptimizerEnabled: () => true,
    shouldInjectOpenAIPromptCacheKey: () => true,
  },
}));
import { extension as activateCacheExtension } from '../../generated/pi';
import {
  DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV,
  DOOMPI_PROMPT_CACHE_CHILD_PROJECTION_ENV,
  DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV,
  PI_CACHE_RETENTION_ENV,
} from '../../src/constants/environment';
import { PromptCacheTelemetry } from '../../src/models/promptCacheTelemetry';

const execution = {
  sessionManager: { getSessionId: () => 'pi-cache-session' },
  model: {
    provider: 'openai-codex',
    id: 'gpt-test',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
  },
} as unknown as ExtensionContext;
const disposals: (() => Promise<unknown>)[] = [];
function fixture(options?: { telemetry: PromptCacheTelemetry; now: () => number }) {
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  const pi = {
    on: vi.fn((event: string, handler: (event: unknown, context: ExtensionContext) => unknown) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
  } as unknown as ExtensionAPI;
  const root = new Context();
  const fiber = root.plugin((context) => activateCacheExtension.install(context, pi, options));
  disposals.push(() => fiber.dispose());
  return { pi, handlers, ready: Promise.resolve(fiber), dispose: () => fiber.dispose() };
}
beforeEach(() => {
  for (const name of [
    DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV,
    DOOMPI_PROMPT_CACHE_CHILD_PROJECTION_ENV,
    DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV,
    PI_CACHE_RETENTION_ENV,
  ])
    vi.stubEnv(name, '');
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllEnvs();
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
    const activation = fixture();
    await vi.waitFor(() => expect(mocks.optimizer).toHaveBeenCalledWith(activation.pi));
    expect(mocks.mount).not.toHaveBeenCalled();
    expect(activation.handlers.size).toBe(0);
    ready();
    await activation.ready;
    expect(mocks.order).toEqual(['optimizer', 'cache']);
    expect(mocks.mount).toHaveBeenCalledWith(
      expect.objectContaining({ now: Date.now }),
      expect.objectContaining({ default: mocks.optimizer }),
    );
    expect([...activation.handlers.keys()]).toEqual(
      expect.arrayContaining(['session_start', 'before_provider_request', 'message_end']),
    );
  });
  it('passes the caller telemetry and clock to the declaration', async () => {
    const dependencies = { telemetry: new PromptCacheTelemetry(), now: () => 123 };
    await fixture(dependencies).ready;
    expect(mocks.mount).toHaveBeenCalledWith(dependencies, expect.objectContaining({ default: mocks.optimizer }));
  });
  it('dispatches real generated hooks with stable keys and observed usage, then disposes them', async () => {
    const telemetry = new PromptCacheTelemetry();
    const activation = fixture({ telemetry, now: () => 123 });
    await activation.ready;
    await activation.handlers.get('session_start')!({ type: 'session_start' }, execution);
    const payload = { model: 'gpt-test', prompt_cache_key: 'pi-cache-session' };
    const request = activation.handlers.get('before_provider_request')!;
    const first = await request({ type: 'before_provider_request', payload }, execution);
    const next = await request({ type: 'before_provider_request', payload: { ...payload, input: [] } }, execution);
    expect(first).toMatchObject({ prompt_cache_key: expect.stringMatching(/^dpc1_/) });
    expect(next).toMatchObject(first as Record<string, unknown>);
    await activation.handlers.get('message_end')!(
      { type: 'message_end', message: { role: 'assistant', usage: { input: 100, cacheRead: 900, cacheWrite: 0 } } },
      execution,
    );
    expect(telemetry.snapshot().lastObservation).toMatchObject({
      cacheRead: 900,
      totalInput: 1000,
      observedAt: 123,
    });
    await activation.dispose();
    expect(activation.handlers.size).toBe(0);
    expect(telemetry.snapshot().observations).toEqual([]);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it('leaves uninitialized and opt-out requests unchanged and ignores failed usage', async () => {
    const telemetry = new PromptCacheTelemetry();
    const activation = fixture({ telemetry, now: () => 123 });
    await activation.ready;
    const request = activation.handlers.get('before_provider_request')!;
    expect(
      await request({ payload: { model: 'gpt-test', prompt_cache_key: 'pi-session' } }, execution),
    ).toBeUndefined();
    await activation.handlers.get('session_start')!({}, execution);
    expect(process.env[DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV]).toMatch(/^dpn1_/);
    expect(await request({ payload: { model: 'gpt-test' } }, execution)).toBeUndefined();
    await activation.handlers.get('message_end')!(
      { message: { role: 'assistant', stopReason: 'error', usage: { input: 10, cacheRead: 90 } } },
      execution,
    );
    expect(telemetry.snapshot().observations).toEqual([]);
  });
  it('keeps an inherited child projection stable across native child session identities', async () => {
    vi.stubEnv(DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV, 'projected-parent');
    vi.stubEnv(DOOMPI_PROMPT_CACHE_CHILD_PROJECTION_ENV, 'same-child-projection');
    vi.stubEnv(PI_CACHE_RETENTION_ENV, 'long');
    const telemetry = new PromptCacheTelemetry();
    const activation = fixture({ telemetry, now: () => 123 });
    await activation.ready;
    const request = { payload: { model: 'gpt-test', prompt_cache_key: 'child-session' } };
    const onRequest = activation.handlers.get('before_provider_request')!;
    await activation.handlers.get('session_start')!({}, execution);
    const first = await onRequest(request, execution);
    const nextChild = { ...execution, sessionManager: { getSessionId: () => 'another-child' } } as ExtensionContext;
    await activation.handlers.get('session_start')!({}, nextChild);
    expect(await onRequest(request, nextChild)).toEqual(first);
    expect(first).toMatchObject({ prompt_cache_key: expect.stringMatching(/^dpc1_/) });
    expect(telemetry.snapshot()).toMatchObject({ namespace: 'projected-parent', requestedRetention: 'long' });
    await activation.dispose();
    expect(process.env[DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV]).toBe('projected-parent');
  });
  it('does not mount cache hooks when optimizer startup fails', async () => {
    const failure = new Error('optimizer startup');
    mocks.optimizer.mockRejectedValue(failure);
    await expect(fixture().ready).rejects.toBe(failure);
    expect(mocks.mount).not.toHaveBeenCalled();
  });
  it('rejects an optimizer module without an extension factory', async () => {
    mocks.optimizerExport = undefined;
    await expect(fixture().ready).rejects.toThrow('Pi Cache Optimizer does not provide an extension factory.');
    expect(mocks.mount).not.toHaveBeenCalled();
  });
});
