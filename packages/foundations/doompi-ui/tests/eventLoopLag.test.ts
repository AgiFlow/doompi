import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startEventLoopLagSampler } from '../src/services/eventLoopLag';

describe('event loop lag sampler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says nothing while the loop wakes on schedule', () => {
    const report = vi.fn();
    const sampler = startEventLoopLagSampler(report);

    vi.advanceTimersByTime(2_000);

    expect(report).not.toHaveBeenCalled();
    sampler.stop();
  });

  it('reports the delay once when a wake arrives late, and not again after', () => {
    const report = vi.fn();
    const sampler = startEventLoopLagSampler(report);

    // One tick that took a second to arrive: the timer is due at 250ms and the
    // clock only reaches it at 1250ms.
    vi.setSystemTime(Date.now() + 1_000);
    vi.advanceTimersByTime(250);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(1_000);

    // The next ticks are on time, so the stall must not echo through them.
    vi.advanceTimersByTime(1_000);
    expect(report).toHaveBeenCalledTimes(1);
    sampler.stop();
  });

  it('stops reporting once stopped', () => {
    const report = vi.fn();
    const sampler = startEventLoopLagSampler(report);
    sampler.stop();

    vi.setSystemTime(Date.now() + 1_000);
    vi.advanceTimersByTime(1_000);

    expect(report).not.toHaveBeenCalled();
  });
});
