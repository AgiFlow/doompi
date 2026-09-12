import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connectDoomCordisHost = vi.fn();

vi.mock('../../../../../../packages/core/doompi-extension-contracts/src/adapters/pi/cordisHost', () => ({
  connectDoomCordisHost: (...args: unknown[]) => connectDoomCordisHost(...args),
}));

vi.mock('@agimon-ai/doompi-config', () => ({
  getHarnessState: () => ({ root: undefined }),
}));

const { activateModelGuidanceExtension } = await import('../../../src/extensions/pi');

type Listener = (...args: unknown[]) => unknown;

interface Recorder {
  readonly pi: { on: (event: string, listener: Listener) => void };
  readonly listeners: Map<string, Listener[]>;
  readonly fiberDispose: ReturnType<typeof vi.fn>;
  readonly connectionDispose: ReturnType<typeof vi.fn>;
  readonly plugin: ReturnType<typeof vi.fn>;
}

/** Builds a fake Pi host whose fiber either settles or fails. */
function createRecorder(fiberOutcome: 'resolve' | 'reject'): Recorder {
  const listeners = new Map<string, Listener[]>();
  const fiberDispose = vi.fn(async () => {});
  const connectionDispose = vi.fn(async () => {});

  const settled = fiberOutcome === 'resolve' ? Promise.resolve() : Promise.reject(new Error('fiber failed'));
  // Swallow the rejection here; the adapter is the one expected to surface it.
  settled.catch(() => {});
  const fiber = Object.assign(settled, { dispose: fiberDispose });

  // Invoke the plugin so its body is exercised the way cordis would run it.
  const plugin = vi.fn((factory: (cordis: unknown, config: unknown) => Promise<void>, config: unknown) => {
    void factory({ effect() {} }, config);
    return fiber;
  });

  connectDoomCordisHost.mockResolvedValue({ root: { plugin }, dispose: connectionDispose });

  return {
    pi: {
      on(event: string, listener: Listener) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
    },
    listeners,
    fiberDispose,
    connectionDispose,
    plugin,
  };
}

beforeEach(() => {
  connectDoomCordisHost.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('activateModelGuidanceExtension', () => {
  it('takes one host lease and mounts exactly one root plugin fiber', async () => {
    const recorder = createRecorder('resolve');

    await activateModelGuidanceExtension(recorder.pi as never);

    expect(connectDoomCordisHost).toHaveBeenCalledTimes(1);
    expect(connectDoomCordisHost).toHaveBeenCalledWith(recorder.pi, '@agimon-ai/doompi-model-guidance');
    expect(recorder.plugin).toHaveBeenCalledTimes(1);
  });

  it('registers the turn handler through the mounted plugin', async () => {
    const recorder = createRecorder('resolve');

    await activateModelGuidanceExtension(recorder.pi as never);

    expect(recorder.listeners.get('before_agent_start')).toHaveLength(1);
  });

  it('disposes the fiber before the host connection on shutdown', async () => {
    const recorder = createRecorder('resolve');
    await activateModelGuidanceExtension(recorder.pi as never);

    const shutdown = recorder.listeners.get('session_shutdown')?.[0];
    await shutdown?.();

    expect(recorder.fiberDispose).toHaveBeenCalledTimes(1);
    expect(recorder.connectionDispose).toHaveBeenCalledTimes(1);
    expect(recorder.fiberDispose.mock.invocationCallOrder[0]).toBeLessThan(
      recorder.connectionDispose.mock.invocationCallOrder[0],
    );
  });

  it('is idempotent when shutdown races with replacement', async () => {
    const recorder = createRecorder('resolve');
    await activateModelGuidanceExtension(recorder.pi as never);

    const shutdown = recorder.listeners.get('session_shutdown')?.[0];
    await Promise.all([shutdown?.(), shutdown?.()]);
    await shutdown?.();

    expect(recorder.fiberDispose).toHaveBeenCalledTimes(1);
    expect(recorder.connectionDispose).toHaveBeenCalledTimes(1);
  });

  it('releases both the fiber and the host lease when the fiber fails to start', async () => {
    const recorder = createRecorder('reject');

    await expect(activateModelGuidanceExtension(recorder.pi as never)).rejects.toThrow('fiber failed');

    expect(recorder.fiberDispose).toHaveBeenCalledTimes(1);
    expect(recorder.connectionDispose).toHaveBeenCalledTimes(1);
    await recorder.listeners.get('session_shutdown')?.[0]?.();
    expect(recorder.fiberDispose).toHaveBeenCalledTimes(1);
    expect(recorder.connectionDispose).toHaveBeenCalledTimes(1);
  });
});
