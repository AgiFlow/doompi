import { describe, expect, it } from 'vitest';
import {
  AUTO_STOP_ACTION,
  type AutoStopDelays,
  DEFAULT_AUTO_STOP_DELAYS,
  decideOnRecheck,
  decideOnSettled,
} from '../../src/services/idlePolicy.ts';

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
