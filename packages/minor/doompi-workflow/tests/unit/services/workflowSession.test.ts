import { describe, expect, it, vi } from 'vitest';

import {
  createWorkflowSessionLifecycle,
  isWorkflowSession,
  workflowSessionActivity,
  workflowSessionBrief,
  workflowSessionName,
  type WorkflowSessionLifecycleDeps,
} from '../../../src/services/workflowSession';
import type { WorkflowRunView } from '../../../src/types/webWorkflows';

const run = (overrides: Partial<WorkflowRunView> = {}): WorkflowRunView => ({
  runKey: 'release-1',
  workspace: 'doompi',
  displayName: 'release',
  workflowPath: '/repo/release.workflow.yml',
  stage: 'running',
  startedAt: '2026-01-01T00:00:00.000Z',
  ownerSessionId: 'child',
  launcherSessionId: 'parent',
  jobs: [],
  ...overrides,
});

function deps(overrides: Partial<WorkflowSessionLifecycleDeps> = {}) {
  return {
    parentSessionId: 'parent',
    publishActivity: vi.fn(),
    postNotice: vi.fn(async () => undefined),
    isIdle: vi.fn(async () => true),
    requestRelease: vi.fn(() => true),
    onPeerReady: vi.fn(() => () => undefined),
    ...overrides,
  } satisfies WorkflowSessionLifecycleDeps;
}

describe('workflow session presenters', () => {
  it('recognises a workflow session by provenance and names it after the workflow', () => {
    expect(isWorkflowSession({ sessionContext: { provenance: 'workflow-session' } })).toBe(true);
    expect(isWorkflowSession({ sessionContext: { provenance: 'workflow' } })).toBe(false);
    expect(isWorkflowSession({})).toBe(false);
    expect(workflowSessionName('/repo/.doom/release-hardening.workflow.yaml')).toBe('release-hardening');
    expect(workflowSessionName('/repo/nightly.yml', ' Nightly ')).toBe('Nightly');
  });

  it('puts a failure or pause ahead of a run in progress on the rail line', () => {
    expect(workflowSessionActivity([])).toBeUndefined();
    expect(workflowSessionActivity([run({ position: { job: 'build', step: 'edit' } })])).toEqual({
      label: 'workflow · build › edit',
      since: '2026-01-01T00:00:00.000Z',
    });
    expect(workflowSessionActivity([run()])).toMatchObject({ label: 'workflow · starting' });
    expect(workflowSessionActivity([run(), run({ runKey: 'b', stage: 'error', failedJob: 'test' })])).toEqual({
      label: 'workflow failed · test',
      attention: true,
    });
    expect(workflowSessionActivity([run({ executionState: 'paused', position: { job: 'migrate' } })])).toEqual({
      label: 'workflow paused · migrate',
      attention: true,
    });
    expect(workflowSessionActivity([run({ stage: 'completed', outcome: 'success' })])).toEqual({
      label: 'workflow succeeded',
    });
  });

  it('briefs the owner agent with each run and how to troubleshoot it', () => {
    expect(workflowSessionBrief([])).toBe('');
    const brief = workflowSessionBrief([run({ stage: 'error', failedJob: 'test', errorMessage: 'exit 1' })]);
    expect(brief).toContain('runKey release-1, workspace doompi');
    expect(brief).toContain("job 'test' failed: exit 1");
    expect(brief).toContain('workflow-recovery');
  });
});

describe('workflow session lifecycle', () => {
  it('reports nothing it did not see change, so a woken session posts and releases nothing', async () => {
    const host = deps();
    const lifecycle = createWorkflowSessionLifecycle(host);
    await lifecycle.observe([run({ stage: 'completed', outcome: 'success', finishedAt: '2026-01-01T00:12:00.000Z' })]);
    expect(host.postNotice).not.toHaveBeenCalled();
    expect(host.requestRelease).not.toHaveBeenCalled();
    expect(host.publishActivity).toHaveBeenCalledWith({ label: 'workflow succeeded' });
  });

  it('posts a failure without asking for a release, and never releases after it', async () => {
    const host = deps();
    const lifecycle = createWorkflowSessionLifecycle(host);
    await lifecycle.observe([run()]);
    await lifecycle.observe([run({ stage: 'error', failedJob: 'test', errorMessage: 'exit 1' })]);
    expect(host.postNotice).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', body: expect.stringContaining('failed at job "test": exit 1') }),
    );
    // Recovered and finished: the reader was here, so the session stays live.
    await lifecycle.observe([run({ stage: 'completed', outcome: 'success' })]);
    expect(host.requestRelease).not.toHaveBeenCalled();
  });

  it('asks its parent to release it after an untouched success, once', async () => {
    const host = deps();
    const lifecycle = createWorkflowSessionLifecycle(host);
    await lifecycle.observe([run()]);
    const done = run({ stage: 'completed', outcome: 'success', finishedAt: '2026-01-01T00:12:00.000Z' });
    await lifecycle.observe([done]);
    expect(host.postNotice).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', body: 'Workflow "release" succeeded in 12m.' }),
    );
    expect(host.requestRelease).toHaveBeenCalledWith('parent', ['release-1']);
    await lifecycle.observe([done]);
    expect(host.requestRelease).toHaveBeenCalledOnce();
  });

  it('stays live once the reader started a turn, or while the agent is busy', async () => {
    const engaged = deps();
    const first = createWorkflowSessionLifecycle(engaged);
    await first.observe([run()]);
    first.agentStarted();
    await first.observe([run({ stage: 'completed', outcome: 'success' })]);
    expect(engaged.requestRelease).not.toHaveBeenCalled();

    const busy = deps({ isIdle: vi.fn(async () => false) });
    const second = createWorkflowSessionLifecycle(busy);
    await second.observe([run()]);
    await second.observe([run({ stage: 'completed', outcome: 'success' })]);
    expect(busy.requestRelease).not.toHaveBeenCalled();
  });

  it('retries the release once when the parent can hear it again', async () => {
    let ready: ((peer: string) => void) | undefined;
    const host = deps({
      requestRelease: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      onPeerReady: vi.fn((listener: (peer: string) => void) => {
        ready = listener;
        return () => undefined;
      }),
    });
    const lifecycle = createWorkflowSessionLifecycle(host);
    await lifecycle.observe([run()]);
    await lifecycle.observe([run({ stage: 'completed', outcome: 'success' })]);
    expect(host.requestRelease).toHaveBeenCalledOnce();
    ready?.('someone-else');
    expect(host.requestRelease).toHaveBeenCalledOnce();
    ready?.('parent');
    expect(host.requestRelease).toHaveBeenCalledTimes(2);
  });

  it('posts nothing for a run its own agent launched in place', async () => {
    const host = deps();
    const lifecycle = createWorkflowSessionLifecycle(host);
    const own = run({ launcherSessionId: undefined });
    await lifecycle.observe([own]);
    await lifecycle.observe([{ ...own, stage: 'error' }]);
    expect(host.postNotice).not.toHaveBeenCalled();
  });
});
