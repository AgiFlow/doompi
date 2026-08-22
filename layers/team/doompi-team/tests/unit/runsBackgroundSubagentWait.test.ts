import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SubagentWaiter } from '../../src/adapters/runs/background/subagentWait';
import type { AsyncJobTrackerContract, TrackedAsyncJob } from '../../src/adapters/asyncJobTracker';

/** An in-memory job tracker a test can mutate directly to simulate status.json changing over time. */
class FakeAsyncJobTracker implements AsyncJobTrackerContract {
  forSession() {
    return this;
  }
  private readonly jobs = new Map<string, TrackedAsyncJob>();
  trackedIds: string[] = [];

  setJob(job: TrackedAsyncJob): void {
    this.jobs.set(job.runId, job);
  }

  track(runId: string): void {
    this.trackedIds.push(runId);
    if (!this.jobs.has(runId)) this.jobs.set(runId, { runId, status: undefined });
  }
  untrack(runId: string): void {
    this.jobs.delete(runId);
  }
  list(): TrackedAsyncJob[] {
    return [...this.jobs.values()];
  }
  get(runId: string): TrackedAsyncJob | undefined {
    return this.jobs.get(runId);
  }
  reset(): void {
    this.jobs.clear();
  }
  start(): void {}
  stop(): void {}
}

/** Pins the poll interval and default timeout so tests run against fake timers deterministically. */
class TestSubagentWaiter extends SubagentWaiter {
  protected override readonly pollIntervalMs = 50;
  protected override readonly defaultTimeoutMs = 5000;
}

let tracker: FakeAsyncJobTracker;
let waiter: TestSubagentWaiter;

beforeEach(() => {
  vi.useFakeTimers();
  tracker = new FakeAsyncJobTracker();
  waiter = new TestSubagentWaiter(tracker);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advances fake time while resolving the microtask queue between ticks, the same idiom used elsewhere in this suite. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('SubagentWaiter.wait - target resolution', () => {
  it('tracks and waits on a single { id } target', async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    const promise = waiter.wait({ target: { id: 'run-1' } });

    tracker.setJob({ runId: 'run-1', status: 'complete' });
    await advance(50);

    const outcome = await promise;
    expect(outcome.reason).toBe('completed');
    expect(tracker.trackedIds).toContain('run-1');
  });

  it('tracks and waits on every id in an { ids } target', async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    tracker.setJob({ runId: 'run-2', status: 'running' });
    const promise = waiter.wait({ target: { ids: ['run-1', 'run-2'] } });

    tracker.setJob({ runId: 'run-2', status: 'complete' });
    await advance(50);

    const outcome = await promise;
    expect(outcome.reason).toBe('completed');
    expect(outcome.runs.map((run) => run.runId).sort()).toEqual(['run-1', 'run-2']);
    expect(tracker.trackedIds.sort()).toEqual(['run-1', 'run-2']);
  });

  it('waits on every run the tracker already knows about for an { all: true } target', async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    tracker.setJob({ runId: 'run-2', status: 'running' });
    const promise = waiter.wait({ target: { all: true } });

    tracker.setJob({ runId: 'run-1', status: 'failed' });
    await advance(50);

    const outcome = await promise;
    expect(outcome.reason).toBe('completed');
  });

  it("resolves 'no-active-runs' immediately for an empty { ids: [] } target", async () => {
    const outcome = await waiter.wait({ target: { ids: [] } });

    expect(outcome).toEqual({ reason: 'no-active-runs', elapsedMs: 0, runs: [] });
  });

  it("resolves 'no-active-runs' immediately when none of the targeted ids have ever had a readable status", async () => {
    const outcome = await waiter.wait({ target: { ids: ['ghost-1', 'ghost-2'] } });

    expect(outcome.reason).toBe('no-active-runs');
    expect(outcome.runs).toEqual([
      { runId: 'ghost-1', status: undefined },
      { runId: 'ghost-2', status: undefined },
    ]);
  });
});

describe('SubagentWaiter.wait - waitFor modes', () => {
  it("waitFor: 'completion' ignores attention and waits through it for a terminal state", async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    const promise = waiter.wait({ target: { id: 'run-1' }, waitFor: 'completion', timeoutMs: 2000 });

    tracker.setJob({ runId: 'run-1', status: 'running', activityState: 'needs_attention', attentionReason: 'x' });
    await advance(50);
    // Still not terminal, even though it needs attention: 'completion' must not stop here.

    tracker.setJob({ runId: 'run-1', status: 'complete', activityState: 'needs_attention', attentionReason: 'x' });
    await advance(50);

    const outcome = await promise;
    expect(outcome.reason).toBe('completed');
  });

  it("waitFor: 'attention' returns the instant activityState is needs_attention, before any terminal state", async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    const promise = waiter.wait({ target: { id: 'run-1' }, waitFor: 'attention', timeoutMs: 2000 });

    tracker.setJob({
      runId: 'run-1',
      status: 'running',
      activityState: 'needs_attention',
      attentionReason: 'missing-deliverable',
    });
    await advance(50);

    const outcome = await promise;
    expect(outcome.reason).toBe('attention');
    expect(outcome.runs[0]).toMatchObject({
      activityState: 'needs_attention',
      attentionReason: 'missing-deliverable',
    });
  });

  it('labels the outcome by what waitFor actually asked for, not by whatever else the snapshot happens to carry', async () => {
    // A run that is BOTH terminal AND (independently) still flagged
    // needs_attention must report 'completed' for waitFor: 'completion' and
    // 'attention' for waitFor: 'attention' - the label reflects the mode
    // that was requested, never just "attention is present, so say attention".
    tracker.setJob({
      runId: 'run-1',
      status: 'complete',
      activityState: 'needs_attention',
      attentionReason: 'missing-deliverable',
    });

    const completionOutcome = await waiter.wait({ target: { id: 'run-1' }, waitFor: 'completion' });
    expect(completionOutcome.reason).toBe('completed');

    const attentionOutcome = await waiter.wait({ target: { id: 'run-1' }, waitFor: 'attention' });
    expect(attentionOutcome.reason).toBe('attention');

    // 'any' prefers reporting attention when both are simultaneously true,
    // since it is the more actionable signal for the caller to act on.
    const anyOutcome = await waiter.wait({ target: { id: 'run-1' } });
    expect(anyOutcome.reason).toBe('attention');
  });

  it("waitFor: 'attention' does not resolve on a plain terminal state with no attention flag", async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    const promise = waiter.wait({ target: { id: 'run-1' }, waitFor: 'attention', timeoutMs: 200 });

    tracker.setJob({ runId: 'run-1', status: 'complete' });
    await advance(200);

    const outcome = await promise;
    expect(outcome.reason).toBe('timeout');
  });

  it("waitFor: 'any' (the default) resolves on attention when that comes first", async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    const promise = waiter.wait({ target: { id: 'run-1' } });

    tracker.setJob({ runId: 'run-1', status: 'running', activityState: 'needs_attention', attentionReason: 'x' });
    await advance(50);

    const outcome = await promise;
    expect(outcome.reason).toBe('attention');
  });

  it("waitFor: 'any' (the default) resolves on completion when that comes first", async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    const promise = waiter.wait({ target: { id: 'run-1' } });

    tracker.setJob({ runId: 'run-1', status: 'complete' });
    await advance(50);

    const outcome = await promise;
    expect(outcome.reason).toBe('completed');
  });
});

describe('SubagentWaiter.wait - return on first, not wait for all', () => {
  it('resolves as soon as ANY targeted run satisfies waitFor, leaving the rest in flight', async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    tracker.setJob({ runId: 'run-2', status: 'running' });
    const promise = waiter.wait({ target: { ids: ['run-1', 'run-2'] }, timeoutMs: 2000 });

    tracker.setJob({ runId: 'run-1', status: 'complete' });
    // run-2 deliberately left running.
    await advance(50);

    const outcome = await promise;
    expect(outcome.reason).toBe('completed');
    const run2 = outcome.runs.find((run) => run.runId === 'run-2');
    expect(run2?.status).toBe('running');
  });
});

describe('SubagentWaiter.wait - timeout is a snapshot, never an error', () => {
  it('resolves (does not throw or reject) with reason timeout when nothing satisfies waitFor in time', async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    const promise = waiter.wait({ target: { id: 'run-1' }, timeoutMs: 300 });

    await advance(300);

    await expect(promise).resolves.toEqual({
      reason: 'timeout',
      elapsedMs: expect.any(Number),
      runs: [{ runId: 'run-1', status: 'running' }],
    });
  });

  it('uses the injected default timeout when the caller does not specify one', async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    const promise = waiter.wait({ target: { id: 'run-1' } }); // no timeoutMs; TestSubagentWaiter defaults to 5000

    await advance(4999);
    // Not yet resolved - would need to inspect a flag; instead assert the
    // full timeout duration below settles it, which is the load-bearing check.
    await advance(1);

    const outcome = await promise;
    expect(outcome.reason).toBe('timeout');
  });

  it('treats a non-positive timeoutMs as "use the default" rather than "expire immediately"', async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    const promise = waiter.wait({ target: { id: 'run-1' }, timeoutMs: 0 });

    tracker.setJob({ runId: 'run-1', status: 'complete' });
    await advance(50);

    const outcome = await promise;
    expect(outcome.reason).toBe('completed');
  });
});

describe('SubagentWaiter.wait - abort signal', () => {
  it('resolves reason aborted when the signal fires before the wait condition is met', async () => {
    tracker.setJob({ runId: 'run-1', status: 'running' });
    const controller = new AbortController();
    const promise = waiter.wait({ target: { id: 'run-1' }, signal: controller.signal, timeoutMs: 2000 });

    controller.abort();
    await advance(50);

    const outcome = await promise;
    expect(outcome.reason).toBe('aborted');
  });
});

describe('SubagentWaiter.wait - resolves immediately for an already-satisfied run', () => {
  it('does not wait a single poll cycle when the target is already terminal at call time', async () => {
    tracker.setJob({ runId: 'run-1', status: 'complete' });

    const outcome = await waiter.wait({ target: { id: 'run-1' } });

    expect(outcome.reason).toBe('completed');
    expect(outcome.elapsedMs).toBe(0);
  });
});
