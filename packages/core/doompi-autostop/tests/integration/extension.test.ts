import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installDoomCordisHost } from '@agimon-ai/doompi-core/cordis-host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoStopExtension } from '../../src/extensions/pi';
import { DEFAULT_AUTO_STOP_DELAYS } from '../../src/exports';
import { createSessionHarness } from '../helpers/session';

const { cooldownMs, recheckMs } = DEFAULT_AUTO_STOP_DELAYS;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('auto-stop Pi factory', () => {
  it('registers the idle watch and the shutdown that disarms it', async () => {
    const session = createSessionHarness();

    await autoStopExtension(session.pi);

    expect(session.registered()).toEqual(
      expect.arrayContaining(['input', 'agent_start', 'agent_settled', 'session_shutdown']),
    );
  });

  it('stops the session once the cooldown passes on an idle empty queue', async () => {
    const session = createSessionHarness();
    await autoStopExtension(session.pi);

    await session.fire('agent_settled');
    vi.advanceTimersByTime(cooldownMs - 1);
    expect(session.shutdown).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(session.shutdown).toHaveBeenCalledTimes(1);
  });

  it('leaves a settled session alone while a message is queued', async () => {
    const session = createSessionHarness();
    await autoStopExtension(session.pi);
    session.state.hasPendingMessages = true;

    await session.fire('agent_settled');
    vi.advanceTimersByTime(cooldownMs * 10);

    expect(session.shutdown).not.toHaveBeenCalled();
  });

  it('polls a stream that has not drained, then stops when it has', async () => {
    const session = createSessionHarness();
    await autoStopExtension(session.pi);
    session.state.isIdle = false;

    await session.fire('agent_settled');
    vi.advanceTimersByTime(cooldownMs);
    expect(session.shutdown).not.toHaveBeenCalled();

    vi.advanceTimersByTime(recheckMs);
    expect(session.shutdown).not.toHaveBeenCalled();

    session.state.isIdle = true;
    vi.advanceTimersByTime(recheckMs);
    expect(session.shutdown).toHaveBeenCalledTimes(1);
  });

  it('abandons a scheduled stop when a message is queued before it fires', async () => {
    const session = createSessionHarness();
    await autoStopExtension(session.pi);

    await session.fire('agent_settled');
    session.state.hasPendingMessages = true;
    vi.advanceTimersByTime(cooldownMs * 10);

    expect(session.shutdown).not.toHaveBeenCalled();
  });

  for (const event of ['input', 'agent_start']) {
    it(`disarms a scheduled stop on ${event}`, async () => {
      const session = createSessionHarness();
      await autoStopExtension(session.pi);

      await session.fire('agent_settled');
      vi.advanceTimersByTime(cooldownMs - 1);
      await session.fire(event);
      vi.advanceTimersByTime(cooldownMs * 10);

      expect(session.shutdown).not.toHaveBeenCalled();
    });
  }

  it('re-arms after a settle that followed a disarm', async () => {
    const session = createSessionHarness();
    await autoStopExtension(session.pi);

    await session.fire('agent_settled');
    await session.fire('input');
    await session.fire('agent_settled');
    vi.advanceTimersByTime(cooldownMs);

    expect(session.shutdown).toHaveBeenCalledTimes(1);
  });

  it('disarms a pending stop on shutdown, idempotently across a reload', async () => {
    const session = createSessionHarness();
    await autoStopExtension(session.pi);

    await session.fire('agent_settled');
    // Pi can fire session_shutdown more than once across a reload.
    await session.fire('session_shutdown');
    await session.fire('session_shutdown');
    vi.advanceTimersByTime(cooldownMs * 10);

    expect(session.shutdown).not.toHaveBeenCalled();
  });

  it('honours caller-supplied delays', async () => {
    const session = createSessionHarness();
    await autoStopExtension(session.pi, { cooldownMs: 20, recheckMs: 5 });

    await session.fire('agent_settled');
    vi.advanceTimersByTime(20);

    expect(session.shutdown).toHaveBeenCalledTimes(1);
  });

  it('disposes the fiber when registration throws', async () => {
    const busHandlers = new Map<string, Set<(payload: unknown) => void>>();
    const context = {
      hasPendingMessages: () => false,
      isIdle: () => true,
      shutdown: vi.fn(),
    } as unknown as ExtensionContext;
    let settled: ((event: unknown, context: ExtensionContext) => void) | undefined;
    let pendingTimerCount = 0;
    const on = vi.fn();
    const pi = {
      events: {
        emit(event: string, payload: unknown) {
          for (const handler of busHandlers.get(event) ?? []) handler(payload);
        },
        on(event: string, handler: (payload: unknown) => void) {
          const listeners = busHandlers.get(event) ?? new Set();
          listeners.add(handler);
          busHandlers.set(event, listeners);
          return () => listeners.delete(handler);
        },
      },
      on,
    } as unknown as ExtensionAPI;
    await installDoomCordisHost(pi, { mode: 'composed', source: 'autostop-registration-test-host' });
    on.mockClear().mockImplementation((event: string, handler: unknown) => {
      if (event === 'agent_settled') settled = handler as typeof settled;
      if (event === 'session_shutdown') {
        settled?.({ type: 'agent_settled' }, context);
        pendingTimerCount = vi.getTimerCount();
        throw new Error('registration boom');
      }
    });

    await expect(autoStopExtension(pi)).rejects.toThrow('registration boom');
    expect(pi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
    expect(pendingTimerCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
