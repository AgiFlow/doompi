import { describe, expect, it, vi } from 'vitest';
import { LiveVoiceController } from '../src/adapters/pi/liveVoiceController.ts';
import type { RealtimeHost } from '../src/adapters/realtime/realtimeHost.ts';
import type { AutoCaptureUi, IClock } from '../src/types/index.ts';

const clock: IClock = {
  now: () => Date.now(),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle),
};

function harness(
  overrides: {
    start?: RealtimeHost['start'];
    poll?: RealtimeHost['poll'];
    sendHost?: RealtimeHost['send'];
    control?: RealtimeHost['control'];
    stop?: RealtimeHost['stop'];
    clock?: IClock;
    manualState?: () => 'idle' | 'recording' | 'transcribing';
    contextText?: () => string;
    isBusy?: () => boolean;
    onActivationStateChange?: (state: 'disabled' | 'starting' | 'active' | 'draining' | 'shuttingDown') => void;
  } = {},
) {
  const host: RealtimeHost = {
    start: vi.fn(overrides.start ?? (async () => undefined)),
    poll: vi.fn(overrides.poll ?? (async (activationId) => ({ activationId, state: 'active', cursor: 0, events: [] }))),
    send: vi.fn(overrides.sendHost ?? (async () => undefined)),
    control: vi.fn(overrides.control ?? (async () => undefined)),
    stop: vi.fn(overrides.stop ?? (async () => undefined)),
  };
  const ui: AutoCaptureUi = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setIndicator: vi.fn(),
  };
  const send = vi.fn();
  const controller = new LiveVoiceController({
    host,
    clock: overrides.clock ?? clock,
    manualState: overrides.manualState ?? (() => 'idle'),
    contextText: overrides.contextText ?? (() => 'Current visible context'),
    isBusy: overrides.isBusy ?? (() => true),
    send,
    createId: () => 'activation-live',
    ...(overrides.onActivationStateChange ? { onActivationStateChange: overrides.onActivationStateChange } : {}),
  });
  return { controller, host, ui, send };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe('LiveVoiceController', () => {
  it('returns promptly in starting state while host startup is pending', async () => {
    const pending = new Promise<void>(() => undefined);
    const { controller, host, ui } = harness({ start: vi.fn(() => pending) });

    await controller.activate(ui);

    expect(controller.state).toBe('starting');
    expect(host.start).toHaveBeenCalledWith(
      'activation-live',
      expect.stringContaining('Current visible context'),
      expect.any(AbortSignal),
    );
    await controller.deactivate(ui);
    expect(host.stop).toHaveBeenCalledWith('activation-live');
    expect(controller.state).toBe('disabled');
  });

  it('delivers source-authorized user text and reports the correlated outcome', async () => {
    let polls = 0;
    const { controller, host, ui, send } = harness({
      poll: vi.fn(async (activationId) => {
        polls += 1;
        return {
          activationId,
          state: 'active' as const,
          cursor: 2,
          events:
            polls === 1
              ? [
                  { sequence: 1, event: { type: 'request' as const, requestId: 'request-1', text: 'Rephrased' } },
                  {
                    sequence: 2,
                    event: {
                      type: 'transcript' as const,
                      role: 'user' as const,
                      text: 'Use exact user text',
                      complete: true,
                    },
                  },
                ]
              : [],
        };
      }),
    });

    await controller.activate(ui);
    await settle();

    expect(controller.state).toBe('active');
    expect(send).toHaveBeenCalledWith('Use exact user text', 'immediate');
    expect(host.send).toHaveBeenCalledWith(
      'activation-live',
      [expect.stringContaining('"delegation_item_id":"request-1"')],
      expect.any(AbortSignal),
    );
    await expect(controller.narrateAgent('Exact words')).resolves.toBe('failed');
    await controller.deactivate(ui);
    await expect(controller.narrateAgent('Exact words')).resolves.toBe('interrupted');
  });

  it('reports each competing request while preserving and delivering only the first', async () => {
    const { controller, host, ui, send } = harness({
      poll: vi.fn(async (activationId) => ({
        activationId,
        state: 'active' as const,
        cursor: 5,
        events: [
          { sequence: 1, event: { type: 'request' as const, requestId: 'request-1', text: 'First' } },
          { sequence: 2, event: { type: 'request' as const, requestId: 'request-1', text: 'First' } },
          { sequence: 3, event: { type: 'request' as const, requestId: 'request-1', text: 'Changed' } },
          { sequence: 4, event: { type: 'request' as const, requestId: 'request-2', text: 'Second' } },
          {
            sequence: 5,
            event: { type: 'transcript' as const, role: 'user' as const, text: 'Exact first request', complete: true },
          },
        ],
      })),
    });

    await controller.activate(ui);
    await settle();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('Exact first request', 'immediate');
    const reports = vi.mocked(host.send).mock.calls.map((call) => call[1].join(''));
    expect(reports).toHaveLength(4);
    expect(reports[0]).toContain('"delegation_item_id":"request-1"');
    expect(reports[0]).toContain('busy');
    expect(reports[1]).toContain('rejected');
    expect(reports[2]).toContain('"delegation_item_id":"request-2"');
    expect(reports[2]).toContain('busy');
    expect(reports[3]).toContain('submitted');
    await controller.deactivate(ui);
  });

  it('aborts a pending correlated host send when deactivated', async () => {
    let sendSignal: AbortSignal | undefined;
    const { controller, host, ui } = harness({
      sendHost: vi.fn(async (_activationId, _messages, signal) => {
        sendSignal = signal;
        await new Promise<void>(() => undefined);
      }),
      poll: vi.fn(async (activationId) => ({
        activationId,
        state: 'active' as const,
        cursor: 2,
        events: [
          { sequence: 1, event: { type: 'request' as const, requestId: 'request-1', text: 'First' } },
          {
            sequence: 2,
            event: { type: 'transcript' as const, role: 'user' as const, text: 'Exact first request', complete: true },
          },
        ],
      })),
    });

    await controller.activate(ui);
    await settle();
    await controller.deactivate(ui);

    expect(sendSignal?.aborted).toBe(true);
    expect(host.stop).toHaveBeenCalledOnce();
  });

  it('times out startup and retires ownership', async () => {
    vi.useFakeTimers();
    try {
      const { controller, host, ui } = harness({ start: vi.fn(async () => new Promise<void>(() => undefined)) });
      await controller.activate(ui);

      await vi.advanceTimersByTimeAsync(20_000);
      await settle();

      expect(controller.state).toBe('disabled');
      expect(controller.activationError).toBe('Live voice startup timed out.');
      expect(host.stop).toHaveBeenCalledWith('activation-live');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires a delegation whose transcript deadline expires', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const { controller, host, ui, send } = harness({
        poll: vi.fn(async (activationId) => {
          polls += 1;
          return {
            activationId,
            state: 'active' as const,
            cursor: polls,
            events:
              polls === 1
                ? [{ sequence: 1, event: { type: 'request' as const, requestId: 'request-old', text: 'Old' } }]
                : polls === 82
                  ? [
                      {
                        sequence: 2,
                        event: {
                          type: 'transcript' as const,
                          role: 'user' as const,
                          text: 'Later unrelated utterance',
                          complete: true,
                        },
                      },
                    ]
                  : [],
          };
        }),
      });

      await controller.activate(ui);
      await settle();
      await vi.advanceTimersByTimeAsync(20_250);

      const reports = vi.mocked(host.send).mock.calls.map((call) => call[1].join(''));
      expect(
        reports.some((report) => report.includes('"delegation_item_id":"request-old"') && report.includes('rejected')),
      ).toBe(true);
      expect(send).not.toHaveBeenCalled();
      await controller.deactivate(ui);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles readiness, browser errors, controls, and bounded initial instructions', async () => {
    const states = vi.fn();
    const { controller, host, ui } = harness({
      contextText: () => 'x'.repeat(20_000),
      onActivationStateChange: states,
      poll: vi.fn(async (activationId) => ({
        activationId,
        state: 'active' as const,
        cursor: 1,
        events: [{ sequence: 1, event: { type: 'ready' as const } }],
        browser: { connection: 'connected' as const, listening: true, speaking: false, muted: false },
      })),
    });

    await controller.activate(ui);
    await settle();
    expect(controller.state).toBe('active');
    expect(vi.mocked(host.start).mock.calls[0]?.[1]).toHaveLength(16_384);
    expect(vi.mocked(host.start).mock.calls[0]?.[1]).toContain('DoomPi is the sole authority');
    controller.setMicrophoneMuted(true);
    controller.setMicrophoneMuted(false);
    controller.interruptSpeech();
    expect(host.control).toHaveBeenNthCalledWith(1, 'activation-live', 'mute', expect.any(AbortSignal));
    expect(host.control).toHaveBeenNthCalledWith(2, 'activation-live', 'unmute', expect.any(AbortSignal));
    expect(host.control).toHaveBeenNthCalledWith(3, 'activation-live', 'interrupt', expect.any(AbortSignal));
    expect(states).toHaveBeenCalledWith('active');
    await controller.deactivate(ui);
  });

  it('fails on realtime errors and ignores a stale operation rejection after restart', async () => {
    let rejectOld!: (error: Error) => void;
    let starts = 0;
    const { controller, ui } = harness({
      start: vi.fn(async () => {
        starts += 1;
        if (starts === 1) await new Promise<void>((_resolve, reject) => (rejectOld = reject));
      }),
    });

    await controller.activate(ui);
    await controller.deactivate(ui);
    await controller.activate(ui);
    await settle();
    rejectOld(new Error('stale startup failure'));
    await settle();
    expect(controller.state).toBe('active');
    expect(controller.activationError).toBeUndefined();
    await controller.deactivate(ui);

    const errored = harness({
      poll: vi.fn(async (activationId) => ({
        activationId,
        state: 'connecting' as const,
        cursor: 1,
        events: [{ sequence: 1, event: { type: 'error' as const, code: 'provider_failure' } }],
      })),
    });
    await errored.controller.activate(errored.ui);
    await settle();
    expect(errored.controller.activationError).toBe('Live voice reported provider_failure.');
    expect(errored.controller.state).toBe('disabled');
    expect(errored.host.stop).toHaveBeenCalledOnce();
  });

  it('fails and stops when the cumulative context update budget is exhausted', async () => {
    vi.useFakeTimers();
    try {
      let contextRevision = 0;
      const { controller, host, ui } = harness({
        contextText: () => `${'x'.repeat(8_191)}${contextRevision++ % 10}`,
      });

      await controller.activate(ui);
      await settle();
      await vi.advanceTimersByTimeAsync(2_000);
      await settle();

      expect(controller.activationError).toBe(
        'Live voice context update budget was exhausted. Start a fresh activation.',
      );
      expect(controller.state).toBe('disabled');
      expect(host.stop).toHaveBeenCalledWith('activation-live');
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes startup failure and stops partial host ownership', async () => {
    const { controller, host, ui } = harness({
      start: vi.fn(async () => {
        throw new Error('browser owner unavailable');
      }),
    });

    await controller.activate(ui);
    await settle();

    expect(controller.state).toBe('disabled');
    expect(controller.activationError).toBe('browser owner unavailable');
    expect(host.stop).toHaveBeenCalledWith('activation-live');
    expect(ui.notify).toHaveBeenCalledWith('browser owner unavailable', 'error');
  });
});
