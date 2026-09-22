import { installDoomCordisHost } from '@agimon-ai/doompi-core/cordisHost';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createPlanModeRuntime = vi.hoisted(() => vi.fn());
vi.mock('../src/services/planMode', () => ({ createPlanModeRuntime }));

const { extension: activatePlanExtension } = await import('../generated/pi');

function runtime(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const handler = vi.fn();
  return {
    tools: ['record_debug_evidence', 'run_fable_plan', 'write_plan', 'complete_plan'].map((name) => ({
      name,
      label: name,
      description: name,
      parameters: { type: 'object' },
      execute: vi.fn(),
    })),
    events: {
      before_agent_start: handler,
      context: handler,
      session_start: handler,
      tool_call: handler,
    },
    ...overrides,
  };
}

function createPi(): { pi: ExtensionAPI; shutdown: () => Promise<void> } {
  const handlers = new Map<string, () => Promise<void>>();
  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const pi = {
    registerTool: vi.fn(),
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
  void installDoomCordisHost(pi, { mode: 'composed', source: 'plan-test-host' });
  return {
    pi,
    shutdown: async () => {
      await handlers.get('session_shutdown')?.();
    },
  };
}

describe('standard Plan composition', () => {
  beforeEach(() => {
    createPlanModeRuntime.mockReset();
    createPlanModeRuntime.mockReturnValue(runtime());
  });

  it('installs the complete Plan factory and awaits its package-local lifecycle', async () => {
    const { pi, shutdown } = createPi();

    await activatePlanExtension(pi);

    expect(createPlanModeRuntime).toHaveBeenCalledOnce();
    expect(createPlanModeRuntime).toHaveBeenCalledWith(pi);
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it('cleans partial initialization before rejecting the factory', async () => {
    const cleanup = vi.fn(async () => undefined);
    const failure = new Error('install failed');
    createPlanModeRuntime.mockImplementationOnce(() =>
      runtime({
        services: [
          (cordis: Context) => {
            cordis.effect(() => cleanup, 'test-partial-plan-runtime');
            throw failure;
          },
        ],
      }),
    );
    const { pi } = createPi();

    await expect(activatePlanExtension(pi)).rejects.toBe(failure);

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('memoizes repeated session shutdown disposal', async () => {
    const cleanup = vi.fn(async () => undefined);
    createPlanModeRuntime.mockImplementationOnce(() => runtime({ onStop: cleanup }));
    const { pi, shutdown } = createPi();
    await activatePlanExtension(pi);

    await Promise.all([shutdown(), shutdown(), shutdown()]);

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('constructs each runtime with its own Pi host', async () => {
    const first = createPi();
    const second = createPi();

    await activatePlanExtension(first.pi);
    await activatePlanExtension(second.pi);

    const firstHost = createPlanModeRuntime.mock.calls[0]?.[0];
    const secondHost = createPlanModeRuntime.mock.calls[1]?.[0];
    expect(firstHost).toBe(first.pi);
    expect(secondHost).toBe(second.pi);
    expect(secondHost).not.toBe(firstHost);
    await Promise.all([first.shutdown(), second.shutdown()]);
  });
});
