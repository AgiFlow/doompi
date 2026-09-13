import { describe, expect, it } from 'vitest';

import { AsyncJobTracker } from '../../src/services/asyncJobTracker';
import { createSessionScope } from '../../src/services/sessionPaths';
import { TEST_SESSION_SCOPE } from '../support/sessionScope';

function runProjection(runId: string) {
  return {
    runId,
    agent: 'worker',
    task: 'task',
    cwd: '/repo',
    runtime: 'claude',
    state: 'running',
    startedAt: 1,
    updatedAt: 1,
  };
}

describe('session-scoped event delivery', () => {
  it('does not expose one session run to another session', () => {
    const tracker = new AsyncJobTracker();
    const scopeA = TEST_SESSION_SCOPE;
    const scopeB = createSessionScope('session-b');
    const jobsA = tracker.forSession(scopeA.rootSessionId, scopeA);
    const jobsB = tracker.forSession(scopeB.rootSessionId, scopeB);

    tracker.upsertExternal(scopeA.rootSessionId, scopeA, runProjection('run-owned-by-a'));

    expect(jobsA.get('run-owned-by-a')).toBeDefined();
    expect(jobsB.get('run-owned-by-a')).toBeUndefined();
  });
});
