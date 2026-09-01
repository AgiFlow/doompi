import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncJobTracker } from '../../src/adapters/asyncJobTracker';
import type { PollSchedulerContract, PollSubscription } from '../../src/adapters/pollScheduler';

/** Captures whatever `AsyncJobTracker` registers, without ticking anything on its own. */
class FakeScheduler implements PollSchedulerContract {
  registered: PollSubscription | undefined;
  unregisterCalls = 0;

  register(subscription: PollSubscription): () => void {
    this.registered = subscription;
    return () => {
      this.unregisterCalls += 1;
      this.registered = undefined;
    };
  }

  wake(): void {
    /* not exercised: this module never calls wake() */
  }
  start(): void {}
  stop(): void {}
}

/**
 * Exposes the protected `readFile` seam over an in-memory map, the same
 * idiom as `TestResultWatcher`: `AsyncJobTracker` reads a fixed path derived
 * from `currentRunsDir()` (a shared, real directory), so its filesystem seam is
 * overridden rather than touching real `node:fs`.
 */
class TestAsyncJobTracker extends AsyncJobTracker {
  protected override readonly pollIntervalMs = 50;
  protected override readonly retentionMs = 1000;

  /** runId -> raw status.json contents, or undefined for "file does not exist". */
  statusFiles = new Map<string, string | undefined>();

  protected override readFile(filePath: string): string | undefined {
    const runId = filePath.split('/').at(-2);
    if (runId === undefined) return undefined;
    return this.statusFiles.get(runId);
  }

  private pendingRead: Promise<void> | undefined;

  protected override async readFileAsync(filePath: string): Promise<string | undefined> {
    await this.pendingRead;
    return this.readFile(filePath);
  }

  /** Park every async read until the returned function is called. */
  blockReads(): () => void {
    let release: () => void = () => {};
    this.pendingRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.pendingRead = undefined;
      release();
    };
  }

  runOnce(): Promise<boolean> {
    return this.run();
  }
}

function statusJson(state: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ runId: 'run-1', agent: 'test-agent', state, ...extra });
}

let scheduler: FakeScheduler;
let tracker: TestAsyncJobTracker;

beforeEach(() => {
  vi.useFakeTimers();
  scheduler = new FakeScheduler();
  tracker = new TestAsyncJobTracker(scheduler);
});

afterEach(() => {
  tracker.stop();
  vi.useRealTimers();
});

describe('AsyncJobTracker.track', () => {
  it('isolates run collections by Pi session identity', () => {
    const first = tracker.forSession('session-a');
    const second = tracker.forSession('session-b');

    first.track('run-1');

    expect(first.get('run-1')).toBeDefined();
    expect(second.get('run-1')).toBeUndefined();
    expect(second.list()).toEqual([]);
  });

  it('reads the current status synchronously, so a caller sees something immediately', () => {
    tracker.statusFiles.set('run-1', statusJson('running', { startedAt: 100, lastUpdate: 200 }));

    tracker.track('run-1');

    expect(tracker.get('run-1')).toEqual({
      runId: 'run-1',
      agent: 'test-agent',
      status: 'running',
      startedAt: 100,
      updatedAt: 200,
    });
  });

  it('projects live metrics and preserves zero values', () => {
    tracker.statusFiles.set(
      'run-1',
      statusJson('running', { lastUpdate: 200, tokens: 0, currentTool: 'Read', toolCount: 0 }),
    );

    tracker.track('run-1');

    expect(tracker.get('run-1')).toMatchObject({ tokens: 0, currentTool: 'Read', toolCount: 0 });
  });

  it('does not invent a token count when status.json omits tokens', () => {
    tracker.statusFiles.set('run-1', statusJson('running', { lastUpdate: 200, currentTool: 'Read', toolCount: 0 }));

    tracker.track('run-1');

    expect(tracker.get('run-1')?.tokens).toBeUndefined();
    expect(tracker.get('run-1')).toMatchObject({ currentTool: 'Read', toolCount: 0 });
  });

  it('reports a change when only a live metric changes', async () => {
    tracker.statusFiles.set('run-1', statusJson('running', { lastUpdate: 200, tokens: 0, toolCount: 0 }));
    tracker.track('run-1');

    tracker.statusFiles.set('run-1', statusJson('running', { lastUpdate: 200, tokens: 5, toolCount: 1 }));

    await expect(tracker.runOnce()).resolves.toBe(true);
  });

  it('tracks a run whose status.json does not exist yet, as status undefined rather than skipping it', () => {
    tracker.track('run-1');

    expect(tracker.get('run-1')).toEqual({ runId: 'run-1', status: undefined });
  });

  it('re-reading via a second track() call refreshes the entry rather than duplicating it', () => {
    tracker.statusFiles.set('run-1', statusJson('queued'));
    tracker.track('run-1');

    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.track('run-1');

    expect(tracker.list()).toHaveLength(1);
    expect(tracker.get('run-1')?.status).toBe('running');
  });

  it("reads activityState and reason, for subagentWait.ts's 'attention' mode", () => {
    tracker.statusFiles.set(
      'run-1',
      statusJson('running', { activityState: 'needs_attention', reason: 'missing-deliverable' }),
    );

    tracker.track('run-1');

    expect(tracker.get('run-1')).toMatchObject({
      activityState: 'needs_attention',
      attentionReason: 'missing-deliverable',
    });
  });

  it.each(['starting', 'working', 'tool', 'waiting_for_reply', 'finalizing', 'active_long_running'] as const)(
    'preserves the %s activity state for UI projection',
    (activityState) => {
      tracker.statusFiles.set('run-1', statusJson('running', { activityState }));

      tracker.track('run-1');

      expect(tracker.get('run-1')?.activityState).toBe(activityState);
    },
  );

  it('drops an activityState value outside the known set rather than passing it through unchecked', () => {
    tracker.statusFiles.set('run-1', statusJson('running', { activityState: 'not-a-real-state' }));

    tracker.track('run-1');

    expect(tracker.get('run-1')?.activityState).toBeUndefined();
  });

  it('leaves activityState/attentionReason undefined for a run that has neither field', () => {
    tracker.statusFiles.set('run-1', statusJson('running'));

    tracker.track('run-1');

    expect(tracker.get('run-1')?.activityState).toBeUndefined();
    expect(tracker.get('run-1')?.attentionReason).toBeUndefined();
  });
});

describe('AsyncJobTracker torn/unreadable reads (must not blank a previously known status)', () => {
  it('keeps the previously known status when a read later returns malformed JSON', async () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.track('run-1');
    expect(tracker.get('run-1')?.status).toBe('running');

    tracker.statusFiles.set('run-1', '{not json');
    await tracker.runOnce();

    expect(tracker.get('run-1')?.status).toBe('running');
  });

  it('keeps the previously known status when a read later returns something that is not an object', async () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.track('run-1');

    tracker.statusFiles.set('run-1', '42');
    await tracker.runOnce();

    expect(tracker.get('run-1')?.status).toBe('running');
  });
});

describe('AsyncJobTracker.run (poll tick)', () => {
  it('reports work when a tracked status changes', async () => {
    tracker.statusFiles.set('run-1', statusJson('queued'));
    tracker.track('run-1');

    tracker.statusFiles.set('run-1', statusJson('running', { lastUpdate: 999 }));
    const changed = await tracker.runOnce();

    expect(changed).toBe(true);
    expect(tracker.get('run-1')?.status).toBe('running');
  });

  it('reports no work when nothing changed', async () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.track('run-1');

    await expect(tracker.runOnce()).resolves.toBe(false);
  });

  it('refreshes every tracked job on one tick, not just the first', async () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.statusFiles.set('run-2', statusJson('running'));
    tracker.track('run-1');
    tracker.track('run-2');

    tracker.statusFiles.set('run-1', statusJson('complete'));
    tracker.statusFiles.set('run-2', statusJson('failed'));
    await tracker.runOnce();

    expect(tracker.get('run-1')?.status).toBe('completed');
    expect(tracker.get('run-2')?.status).toBe('failed');
  });
});

describe('AsyncJobTracker retention and eviction', () => {
  it('keeps a terminal job queryable immediately after it finishes, not evicted right away', async () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.track('run-1');
    tracker.statusFiles.set('run-1', statusJson('complete'));
    await tracker.runOnce();

    expect(tracker.get('run-1')).toBeDefined();
  });

  it('evicts a terminal job once it has aged past retentionMs', async () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.track('run-1');
    tracker.statusFiles.set('run-1', statusJson('complete'));
    await tracker.runOnce(); // observes the transition to terminal, starts the retention clock

    vi.advanceTimersByTime(1001); // past the 1000ms test retentionMs
    await tracker.runOnce();

    expect(tracker.get('run-1')).toBeUndefined();
  });

  it('does not evict an in-flight (non-terminal) job no matter how long it has been tracked', async () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.track('run-1');

    vi.advanceTimersByTime(10_000);
    await tracker.runOnce();

    expect(tracker.get('run-1')).toBeDefined();
  });

  it('recognizes each of the five terminal states', async () => {
    for (const state of ['complete', 'completed', 'failed', 'paused', 'stopped']) {
      const runId = `run-${state}`;
      tracker.statusFiles.set(runId, statusJson('running'));
      tracker.track(runId);
      tracker.statusFiles.set(runId, statusJson(state));
      await tracker.runOnce();
    }

    vi.advanceTimersByTime(1001);
    await tracker.runOnce();

    for (const state of ['complete', 'completed', 'failed', 'paused', 'stopped']) {
      expect(tracker.get(`run-${state}`)).toBeUndefined();
    }
  });
});

describe('AsyncJobTracker.untrack', () => {
  it('drops a job immediately, without waiting out any retention window', () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.track('run-1');

    tracker.untrack('run-1');

    expect(tracker.get('run-1')).toBeUndefined();
  });

  it('stops polling it on the next tick', async () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.track('run-1');
    tracker.untrack('run-1');

    tracker.statusFiles.set('run-1', statusJson('complete'));
    const changed = await tracker.runOnce();

    expect(changed).toBe(false);
    expect(tracker.get('run-1')).toBeUndefined();
  });
});

describe('AsyncJobTracker.reset', () => {
  it('drops every tracked job', () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.statusFiles.set('run-2', statusJson('running'));
    tracker.track('run-1');
    tracker.track('run-2');

    tracker.reset();

    expect(tracker.list()).toEqual([]);
  });
});

describe('AsyncJobTracker <-> PollScheduler registration', () => {
  it('registers exactly one subscriber on start', () => {
    tracker.start();

    expect(scheduler.registered?.id).toBe('async-job-tracker');
    expect(scheduler.registered?.intervalMs).toBe(50);
  });

  it('unregisters and drops all tracked jobs on stop', () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.track('run-1');
    tracker.start();

    tracker.stop();

    expect(scheduler.unregisterCalls).toBe(1);
    expect(tracker.list()).toEqual([]);
  });

  it('drives refresh through the exact callback PollScheduler would call', async () => {
    tracker.start();
    tracker.statusFiles.set('run-1', statusJson('queued'));
    tracker.track('run-1');

    tracker.statusFiles.set('run-1', statusJson('running', { lastUpdate: 5 }));
    const workHappened = await scheduler.registered?.run();

    expect(workHappened).toBe(true);
    expect(tracker.get('run-1')?.status).toBe('running');
  });

  it('a second start() resets whatever the previous session was tracking, the same reset idiom as ResultWatcher.start', () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.track('run-1');
    tracker.start();

    tracker.start();

    expect(tracker.list()).toEqual([]);
  });
});

/** The tick awaits per run, so teardown can land between two of those awaits. */
function sessionCount(subject: AsyncJobTracker): number {
  return (subject as unknown as { sessions: Map<string, unknown> }).sessions.size;
}

describe('AsyncJobTracker teardown during an in-flight tick', () => {
  it('stop() called mid-await leaves no sessions behind', async () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.forSession('session-a').track('run-1');
    tracker.start();

    const releaseReads = tracker.blockReads();
    const tick = tracker.runOnce();
    tracker.stop();
    releaseReads();
    await tick;

    // Resurrection here is what made stop() not stop: the in-flight refresh
    // would recreate the deleted session and write the job back into it.
    expect(sessionCount(tracker)).toBe(0);
    expect(tracker.forSession('session-a').list()).toEqual([]);
  });

  it('reset() called mid-await does not bring the reset session back', async () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.statusFiles.set('run-2', statusJson('running'));
    const session = tracker.forSession('session-a');
    session.track('run-1');
    tracker.forSession('session-b').track('run-2');

    const releaseReads = tracker.blockReads();
    const tick = tracker.runOnce();
    session.reset();
    releaseReads();
    await tick;

    expect(session.list()).toEqual([]);
    expect(sessionCount(tracker)).toBe(1);
    expect(tracker.forSession('session-b').list()).toHaveLength(1);
  });

  it('a tick with no teardown still refreshes every session', async () => {
    tracker.statusFiles.set('run-1', statusJson('running'));
    tracker.forSession('session-a').track('run-1');

    tracker.statusFiles.set('run-1', statusJson('complete'));
    await expect(tracker.runOnce()).resolves.toBe(true);

    expect(tracker.forSession('session-a').get('run-1')?.status).toBe('completed');
  });
});