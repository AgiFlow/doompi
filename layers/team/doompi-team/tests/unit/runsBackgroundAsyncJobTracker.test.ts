import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncJobTracker, resolveTrackedRunId } from '../../src/services/asyncJobTracker';
import type { ExternalRunProjection } from '../../src/services/externalProcessIpc';
import { createSessionScope } from '../../src/services/sessionPaths';
import { TEST_SESSION_SCOPE } from '../support/sessionScope';

const scopeA = TEST_SESSION_SCOPE;
const scopeB = createSessionScope('tracker-session-b');

function projection(
  runId: string,
  state: string,
  overrides: Partial<ExternalRunProjection> = {},
): ExternalRunProjection {
  return {
    runId,
    agent: 'worker',
    task: 'task',
    cwd: '/repo',
    runtime: 'claude',
    state,
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('AsyncJobTracker event-fed state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('isolates event-fed runs by session scope', () => {
    const tracker = new AsyncJobTracker();
    const first = tracker.forSession(scopeA.rootSessionId, scopeA);
    const second = tracker.forSession(scopeB.rootSessionId, scopeB);

    tracker.upsertExternal(scopeA.rootSessionId, scopeA, projection('run-1', 'running'));

    expect(first.get('run-1')).toMatchObject({ status: 'running', runtime: 'claude' });
    expect(second.get('run-1')).toBeUndefined();
  });

  // Both upsert paths rebuild the record instead of merging into it, so an
  // identity set at track time is exactly the kind of field they drop. It would
  // fail silently and only from the second event onward.
  it('keeps a tracked identity across an external status update', () => {
    const tracker = new AsyncJobTracker();
    const jobs = tracker.forSession(scopeA.rootSessionId, scopeA);
    jobs.track('run-1', { identity: 'alan-worker-1', inline: true });

    tracker.upsertExternal(scopeA.rootSessionId, scopeA, projection('run-1', 'running'));

    expect(jobs.get('run-1')).toMatchObject({ identity: 'alan-worker-1', inline: true, status: 'running' });
  });

  it('keeps the identity a native projection carries across its own updates', () => {
    const tracker = new AsyncJobTracker();
    const jobs = tracker.forSession(scopeA.rootSessionId, scopeA);
    const native = (state: string) => ({
      runId: 'run-2',
      agent: 'worker',
      identity: 'bea-worker-2',
      inline: false,
      task: 'task',
      cwd: '/repo',
      runtime: 'pi',
      status: state,
      startedAt: 1,
      updatedAt: state === 'running' ? 3 : 2,
    });

    tracker.upsertNative(scopeA.rootSessionId, scopeA, native('queued'));
    tracker.upsertNative(scopeA.rootSessionId, scopeA, native('running'));

    expect(jobs.get('run-2')).toMatchObject({ identity: 'bea-worker-2', status: 'running' });
  });

  it('resolves a run by its identity, but never ahead of a real run id', () => {
    const tracker = new AsyncJobTracker();
    const jobs = tracker.forSession(scopeA.rootSessionId, scopeA);
    jobs.track('run-1', { identity: 'alan-worker-1', inline: false });
    jobs.track('alan-worker-1', { identity: 'cyrus-worker-3', inline: false });

    // 'alan-worker-1' is both an identity of one run and the run id of another.
    // The run id has to win, or addressing becomes ambiguous the moment a
    // generated name collides with an id.
    expect(resolveTrackedRunId(jobs, 'alan-worker-1')).toBe('alan-worker-1');
    expect(resolveTrackedRunId(jobs, 'cyrus-worker-3')).toBe('alan-worker-1');
    expect(resolveTrackedRunId(jobs, 'run-1')).toBe('run-1');
  });
  it('notifies subscribers when status events add and update a run', () => {
    const tracker = new AsyncJobTracker();
    const listener = vi.fn();
    const jobs = tracker.forSession(scopeA.rootSessionId, scopeA);
    tracker.subscribe(scopeA.rootSessionId, listener);

    tracker.upsertExternal(scopeA.rootSessionId, scopeA, projection('run-1', 'queued'));
    tracker.upsertExternal(scopeA.rootSessionId, scopeA, projection('run-1', 'running', { updatedAt: 3 }));

    expect(jobs.get('run-1')).toMatchObject({ status: 'running', updatedAt: 3 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('projects a terminal result and retains it until handoff plus retention', () => {
    const tracker = new AsyncJobTracker();
    const jobs = tracker.forSession(scopeA.rootSessionId, scopeA);
    tracker.upsertExternal(scopeA.rootSessionId, scopeA, projection('run-1', 'running'));

    expect(
      tracker.acceptExternalResult(scopeA.rootSessionId, scopeA, 'run-1', { success: true, summary: 'done' }),
    ).toBe(true);
    expect(jobs.get('run-1')).toMatchObject({ status: 'completed', summary: 'done' });
    expect(tracker.listBackgroundWork(scopeA.rootSessionId)).toHaveLength(1);

    tracker.acknowledgeHandoff(scopeA.rootSessionId, 'run-1');
    expect(tracker.listBackgroundWork(scopeA.rootSessionId)).toEqual([]);
    expect(jobs.get('run-1')).toBeDefined();

    vi.advanceTimersByTime(10_001);
    expect(jobs.get('run-1')).toBeDefined();
    vi.advanceTimersByTime(10 * 60_000 - 10_000);
    expect(jobs.get('run-1')).toBeUndefined();
  });

  it('rejects a result for an unknown run without creating state', () => {
    const tracker = new AsyncJobTracker();
    expect(tracker.acceptExternalResult(scopeA.rootSessionId, scopeA, 'missing', { success: true })).toBe(false);
    expect(tracker.forSession(scopeA.rootSessionId, scopeA).list()).toEqual([]);
  });
});
