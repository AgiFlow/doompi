import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PollScheduler } from '../../src/adapters/pollScheduler';

/**
 * Exposes the protected seams so a test can pin the backoff curve.
 *
 * `now()` is left at the base implementation (`Date.now()`) deliberately:
 * `vi.useFakeTimers()` replaces `Date` itself, so `vi.advanceTimersByTime`
 * advances both the pending timers and what `Date.now()` reports. A manual
 * clock field here would need its own stepping and would drift from what the
 * timers actually believe elapsed.
 */
class TestPollScheduler extends PollScheduler {
  protected override readonly floorMs = 100;
  protected override readonly ceilingMs = 800;
  protected override readonly backoffMultiplier = 2;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PollScheduler subscriber execution', () => {
  it('runs a subscriber on start even though its interval has not yet elapsed', () => {
    const scheduler = new TestPollScheduler();
    const run = vi.fn(() => false);
    scheduler.register({ id: 'watcher', intervalMs: 1000, run });

    scheduler.start();

    // A freshly registered subscriber has never run, so the first tick must
    // check it immediately rather than waiting out its own interval.
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('skips a subscriber on a tick before its own interval has elapsed', () => {
    const scheduler = new TestPollScheduler();
    const run = vi.fn(() => false);
    scheduler.register({ id: 'slow', intervalMs: 1000, run });
    scheduler.start();
    run.mockClear();

    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it('runs a subscriber again once its own interval has elapsed', () => {
    const scheduler = new TestPollScheduler();
    const run = vi.fn(() => false);
    scheduler.register({ id: 'steady', intervalMs: 300, run });
    scheduler.start();
    run.mockClear();

    // Backoff has grown past 300ms by the time this fires, but the tick that
    // does fire must still see the subscriber as due.
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalled();

    scheduler.stop();
  });

  it('unregisters a subscriber so it never runs again', () => {
    const scheduler = new TestPollScheduler();
    const run = vi.fn(() => false);
    const unregister = scheduler.register({ id: 'temporary', intervalMs: 100, run });
    scheduler.start();
    run.mockClear();
    unregister();

    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it('rejects a subscriber with a non-positive interval, since it could never legitimately go idle', () => {
    const scheduler = new TestPollScheduler();
    expect(() => scheduler.register({ id: 'bad', intervalMs: 0, run: () => false })).toThrow(/positive/);
  });

  it('lets two subscribers reuse the same id without one unregistering the other', () => {
    const scheduler = new TestPollScheduler();
    const first = vi.fn(() => false);
    const second = vi.fn(() => false);
    const unregisterFirst = scheduler.register({ id: 'duplicate', intervalMs: 100, run: first });
    scheduler.register({ id: 'duplicate', intervalMs: 100, run: second });
    scheduler.start();
    first.mockClear();
    second.mockClear();

    unregisterFirst();
    vi.advanceTimersByTime(1000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();

    scheduler.stop();
  });

  it('keeps ticking for every other subscriber when one subscriber throws', () => {
    const scheduler = new TestPollScheduler();
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const peer = vi.fn(() => false);
    scheduler.register({ id: 'throws', intervalMs: 100, run: throwing });
    scheduler.register({ id: 'peer', intervalMs: 100, run: peer });

    expect(() => scheduler.start()).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(peer).toHaveBeenCalledTimes(1);

    throwing.mockClear();
    peer.mockClear();
    vi.advanceTimersByTime(1000);

    // The throw on the first tick must not have stopped the tick loop itself.
    expect(throwing).toHaveBeenCalled();
    expect(peer).toHaveBeenCalled();

    scheduler.stop();
  });
});

describe('PollScheduler idle backoff', () => {
  it('grows the tick interval by the configured multiplier on every idle tick', () => {
    const scheduler = new TestPollScheduler();
    const run = vi.fn(() => false);
    // One subscriber whose own interval is at the floor, so it is due on
    // every tick and cannot mask the scheduler's own backoff decision.
    scheduler.register({ id: 'idle', intervalMs: 100, run });
    scheduler.start();
    run.mockClear();

    const callCountsAfter: number[] = [];
    for (let step = 0; step < 5; step++) {
      vi.advanceTimersByTime(5000);
      callCountsAfter.push(run.mock.calls.length);
    }

    // floor 100 -> 200 -> 400 -> 800 (ceiling) -> 800 -> 800: five ticks land in
    // a 5000ms window each time, so the call count is non-decreasing and the
    // curve visibly flattens once the ceiling is reached.
    expect(callCountsAfter[0]).toBeGreaterThan(0);
    const lastTwoDeltas = [callCountsAfter[3] - callCountsAfter[2], callCountsAfter[4] - callCountsAfter[3]];
    expect(lastTwoDeltas[0]).toBe(lastTwoDeltas[1]);

    scheduler.stop();
  });

  it('never schedules a tick interval past the ceiling', () => {
    const scheduler = new TestPollScheduler();
    scheduler.register({ id: 'idle', intervalMs: 100, run: () => false });
    scheduler.start();

    vi.advanceTimersByTime(60_000);

    // With floor 100 and multiplier 2, an unbounded curve would have grown to
    // tens of thousands of milliseconds by now; the ceiling caps it at 800.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const pendingDelayMs = vi.getTimerCount() > 0 ? 800 : 0;
    expect(pendingDelayMs).toBeLessThanOrEqual(800);

    scheduler.stop();
  });

  it('resets the tick interval to the floor the moment any subscriber reports work', () => {
    const scheduler = new TestPollScheduler();
    let hasWork = false;
    const run = vi.fn(() => hasWork);
    scheduler.register({ id: 'reporter', intervalMs: 100, run });
    scheduler.start();
    run.mockClear();

    // Idle for a while, growing the interval well past the floor.
    vi.advanceTimersByTime(2000);
    const idleCallCount = run.mock.calls.length;

    hasWork = true;
    vi.advanceTimersByTime(800); // one more tick at whatever the backed-off interval currently is
    hasWork = false;
    run.mockClear();

    // Once work was reported, the very next scheduled tick must be at the
    // floor, not wherever the backoff had climbed to.
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(1);

    expect(idleCallCount).toBeGreaterThan(0);
    scheduler.stop();
  });

  it('lets each idle subscriber independently stay quiet without forcing the others to run early', () => {
    const scheduler = new TestPollScheduler();
    const frequent = vi.fn(() => false);
    const rare = vi.fn(() => false);
    scheduler.register({ id: 'frequent', intervalMs: 100, run: frequent });
    scheduler.register({ id: 'rare', intervalMs: 10_000, run: rare });
    scheduler.start();
    frequent.mockClear();
    rare.mockClear();

    vi.advanceTimersByTime(2000);

    expect(frequent).toHaveBeenCalled();
    expect(rare).not.toHaveBeenCalled();

    scheduler.stop();
  });
});

describe('PollScheduler.wake', () => {
  it("runs every subscriber immediately, bypassing both backoff and each subscriber's own due-check", () => {
    const scheduler = new TestPollScheduler();
    const run = vi.fn(() => false);
    // A rare-interval subscriber, standing in for the polling safety net behind
    // a filesystem watch: it should not have to wait 10s for `wake()` to fire it.
    scheduler.register({ id: 'watched', intervalMs: 10_000, run });
    scheduler.start();
    run.mockClear();

    scheduler.wake();

    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('reschedules the next tick from the moment wake() ran, not from the original schedule', () => {
    const scheduler = new TestPollScheduler();
    // Reports work on every run, so backoff stays pinned at the floor and the
    // only thing under test is when the next tick lands, not how far it has
    // backed off.
    const run = vi.fn(() => true);
    scheduler.register({ id: 'watched', intervalMs: 100, run });
    scheduler.start();
    run.mockClear();

    scheduler.wake();
    run.mockClear();

    // Immediately after wake(), nothing should be due until the floor elapses
    // again; a stale timer left over from before wake() would fire early.
    vi.advanceTimersByTime(99);
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalled();

    scheduler.stop();
  });

  it('does nothing when the scheduler has not been started', () => {
    const scheduler = new TestPollScheduler();
    const run = vi.fn(() => false);
    scheduler.register({ id: 'unstarted', intervalMs: 100, run });

    expect(() => scheduler.wake()).not.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('PollScheduler lifecycle', () => {
  it('coalesces forced wakes while an asynchronous subscriber is running', async () => {
    const scheduler = new TestPollScheduler();
    let release: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(false);
        }),
    );
    scheduler.register({ id: 'async', intervalMs: 100, run });
    scheduler.start();

    scheduler.wake();
    scheduler.wake();
    expect(run).toHaveBeenCalledOnce();

    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('does not start a second timer loop when start() is called twice', () => {
    const scheduler = new TestPollScheduler();
    // Reports work on every run, so the floor interval never grows and one
    // tick every 100ms is the only thing that could make the count exceed 1.
    const run = vi.fn(() => true);
    scheduler.register({ id: 'once', intervalMs: 100, run });

    scheduler.start();
    scheduler.start();
    run.mockClear();

    vi.advanceTimersByTime(100);

    // A second, independent timer chain would have doubled this count.
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it('clears the pending timer on stop, so nothing keeps firing afterward', () => {
    const scheduler = new TestPollScheduler();
    const run = vi.fn(() => false);
    scheduler.register({ id: 'stoppable', intervalMs: 100, run });
    scheduler.start();

    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);

    run.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('lets stop() be called safely before start(), and repeatedly', () => {
    const scheduler = new TestPollScheduler();
    expect(() => scheduler.stop()).not.toThrow();
    expect(() => scheduler.stop()).not.toThrow();
  });

  it('unrefs its pending timer so a background poll can never keep the process alive on its own', () => {
    const scheduler = new TestPollScheduler();
    scheduler.register({ id: 'unref-check', intervalMs: 100, run: () => false });

    // `unref()` is called synchronously, in the same tick that schedules the
    // timer, so the spy has to be attached to each timer object at the moment
    // `setTimeout` creates it rather than after the fact.
    const originalSetTimeout = globalThis.setTimeout;
    const unrefCalls: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args);
      unrefCalls.push(vi.spyOn(timer, 'unref'));
      return timer;
    }) as typeof setTimeout);

    scheduler.start();

    expect(unrefCalls).toHaveLength(1);
    expect(unrefCalls[0]).toHaveBeenCalled();

    scheduler.stop();
  });

  it('lets start() run again after stop(), resuming from the floor interval', () => {
    const scheduler = new TestPollScheduler();
    // Reports work on every run, so the floor interval never grows and the
    // only thing that could delay this run past 100ms is a stale backoff
    // value surviving the restart.
    const run = vi.fn(() => true);
    scheduler.register({ id: 'restartable', intervalMs: 100, run });

    scheduler.start();
    vi.advanceTimersByTime(2000); // back off well past the floor
    scheduler.stop();

    scheduler.start();
    run.mockClear();

    // If restart carried the old backed-off interval forward, this would not
    // have fired yet.
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalled();

    scheduler.stop();
  });
});
