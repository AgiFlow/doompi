import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTO_STOP_ACTION,
  type AutoStopDelays,
  DEFAULT_AUTO_STOP_DELAYS,
  decideOnRecheck,
  decideOnSettled,
} from '../../src/exports';
import type { BackgroundWorkSummary } from '../../src/services/backgroundWorkGate';
import { createIdleShutdown } from '../../src/services/idleShutdown';

const delays: AutoStopDelays = { cooldownMs: 4_000, recheckMs: 50 };

describe('decideOnSettled', () => {
  it('waits out the cooldown before looking again', () => {
    expect(decideOnSettled({ hasPendingMessages: false, isIdle: true }, delays)).toEqual({
      action: AUTO_STOP_ACTION.recheck,
      delayMs: delays.cooldownMs,
    });
  });

  it('stands down while a message is queued', () => {
    expect(decideOnSettled({ hasPendingMessages: true, isIdle: true }, delays)).toEqual({
      action: AUTO_STOP_ACTION.standDown,
    });
  });

  it('never stops on the settle itself, even when the session already looks idle', () => {
    const decision = decideOnSettled({ hasPendingMessages: false, isIdle: true }, delays);
    expect(decision.action).not.toBe(AUTO_STOP_ACTION.shutdown);
  });
});

describe('decideOnRecheck', () => {
  it('stops a session that is idle with an empty queue', () => {
    expect(decideOnRecheck({ hasPendingMessages: false, isIdle: true }, delays)).toEqual({
      action: AUTO_STOP_ACTION.shutdown,
    });
  });

  it('polls a session that settled but is still streaming', () => {
    expect(decideOnRecheck({ hasPendingMessages: false, isIdle: false }, delays)).toEqual({
      action: AUTO_STOP_ACTION.recheck,
      delayMs: delays.recheckMs,
    });
  });

  it('stands down as soon as a message is queued, idle or not', () => {
    for (const isIdle of [true, false]) {
      expect(decideOnRecheck({ hasPendingMessages: true, isIdle }, delays)).toEqual({
        action: AUTO_STOP_ACTION.standDown,
      });
    }
  });
});

describe('DEFAULT_AUTO_STOP_DELAYS', () => {
  it('gives the user a far longer grace period than the stream poll', () => {
    expect(DEFAULT_AUTO_STOP_DELAYS).toEqual({ cooldownMs: 5_000, recheckMs: 100 });
    expect(DEFAULT_AUTO_STOP_DELAYS.cooldownMs).toBeGreaterThan(DEFAULT_AUTO_STOP_DELAYS.recheckMs);
  });
});

describe('idle shutdown diagnostics', () => {
  const { cooldownMs } = DEFAULT_AUTO_STOP_DELAYS;
  const idle: BackgroundWorkSummary = { active: false, items: [], errors: [] };
  const busy: BackgroundWorkSummary = { active: true, items: ['doom-runner:runner-1'], errors: [] };

  const createContext = (state: { hasPendingMessages: boolean }) =>
    ({
      hasPendingMessages: () => state.hasPendingMessages,
      isIdle: () => true,
      shutdown: vi.fn(),
    }) as unknown as ExtensionContext & { shutdown: ReturnType<typeof vi.fn> };
  const createDiagnostics = () => ({
    waiting: vi.fn(),
    stoodDown: vi.fn(),
    shutdownRequested: vi.fn(),
    reset: vi.fn(),
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports each wait on background work, then the shutdown that ends it', () => {
    let work = busy;
    const diagnostics = createDiagnostics();
    const context = createContext({ hasPendingMessages: false });
    const watch = createIdleShutdown(DEFAULT_AUTO_STOP_DELAYS, () => work, diagnostics);

    watch.settled(context);
    vi.advanceTimersByTime(cooldownMs * 2);
    expect(diagnostics.waiting).toHaveBeenCalledTimes(2);
    expect(diagnostics.waiting).toHaveBeenCalledWith(busy);

    work = idle;
    vi.advanceTimersByTime(cooldownMs);
    expect(diagnostics.shutdownRequested).toHaveBeenCalledTimes(1);
    expect(context.shutdown).toHaveBeenCalledTimes(1);
  });

  it('records a stand-down when a message is already queued at settle', () => {
    const diagnostics = createDiagnostics();
    const watch = createIdleShutdown(DEFAULT_AUTO_STOP_DELAYS, () => idle, diagnostics);

    watch.settled(createContext({ hasPendingMessages: true }));

    expect(diagnostics.stoodDown).toHaveBeenCalledTimes(1);
  });

  it('records a stand-down when a message is queued during the cooldown', () => {
    const state = { hasPendingMessages: false };
    const diagnostics = createDiagnostics();
    const context = createContext(state);
    const watch = createIdleShutdown(DEFAULT_AUTO_STOP_DELAYS, () => idle, diagnostics);

    watch.settled(context);
    state.hasPendingMessages = true;
    vi.advanceTimersByTime(cooldownMs);

    expect(diagnostics.stoodDown).toHaveBeenCalledTimes(1);
    expect(context.shutdown).not.toHaveBeenCalled();
  });

  it('resets the wait when the session becomes active again', () => {
    const diagnostics = createDiagnostics();
    const watch = createIdleShutdown(DEFAULT_AUTO_STOP_DELAYS, () => busy, diagnostics);

    watch.settled(createContext({ hasPendingMessages: false }));
    watch.cancel();
    vi.advanceTimersByTime(cooldownMs * 2);

    expect(diagnostics.reset).toHaveBeenCalled();
    expect(diagnostics.waiting).not.toHaveBeenCalled();
  });
});
