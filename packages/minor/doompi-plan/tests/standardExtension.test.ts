import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const planModeExtension = vi.hoisted(() => vi.fn());
vi.mock('../src/services/planMode.ts', () => ({ planModeExtension }));

const { activatePlanExtension } = await import('../src/adapters/pi/extension.ts');

function createPi(): { pi: ExtensionAPI; shutdown: () => Promise<void> } {
  const handlers = new Map<string, () => Promise<void>>();
  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const pi = {
    events: {
      emit(event: string, payload: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) handler(payload);
      },
      on(event: string, handler: (payload: unknown) => void) {
        const listeners = eventHandlers.get(event) ?? new Set();
        listeners.add(handler);
        eventHandlers.set(event, listeners);
        return () => listeners.delete(handler);
      },
    },
    on(event: string, handler: () => Promise<void>) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    shutdown: async () => {
      await handlers.get('session_shutdown')?.();
    },
  };
}

describe('standard Plan composition', () => {
  beforeEach(() => {
    planModeExtension.mockReset();
  });

  it('installs the complete Plan factory and awaits its package-local lifecycle', async () => {
    const { pi, shutdown } = createPi();

    await activatePlanExtension(pi);

    expect(planModeExtension).toHaveBeenCalledOnce();
    expect(planModeExtension).toHaveBeenCalledWith(expect.any(Context), pi);
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it('cleans partial initialization before rejecting the factory', async () => {
    const cleanup = vi.fn(async () => undefined);
    const failure = new Error('install failed');
    planModeExtension.mockImplementationOnce((cordis: Context) => {
      cordis.effect(() => cleanup, 'test-partial-plan-runtime');
      throw failure;
    });
    const { pi } = createPi();

    await expect(activatePlanExtension(pi)).rejects.toBe(failure);

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('memoizes repeated session shutdown disposal', async () => {
    const cleanup = vi.fn(async () => undefined);
    planModeExtension.mockImplementationOnce((cordis: Context) => {
      cordis.effect(() => cleanup, 'test-plan-runtime');
    });
    const { pi, shutdown } = createPi();
    await activatePlanExtension(pi);

    await Promise.all([shutdown(), shutdown(), shutdown()]);

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('creates a fresh Cordis root when Pi recreates the factory', async () => {
    const first = createPi();
    const second = createPi();

    await activatePlanExtension(first.pi);
    await activatePlanExtension(second.pi);

    const firstRoot = planModeExtension.mock.calls[0]?.[0];
    const secondRoot = planModeExtension.mock.calls[1]?.[0];
    expect(firstRoot).toBeInstanceOf(Context);
    expect(secondRoot).toBeInstanceOf(Context);
    expect(secondRoot).not.toBe(firstRoot);
    await Promise.all([first.shutdown(), second.shutdown()]);
  });
});
