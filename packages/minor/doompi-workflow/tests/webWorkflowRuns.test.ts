import { describe, expect, it } from 'vitest';
import type { WorkflowProgressEvent, WorkflowRunRecord } from '@agimon-ai/workflow-mcp';
import {
  foldWorkflowProgress,
  parseWorkflowProgress,
  parseWorkflowRunRecord,
  presentWorkflowRuns,
  resolveWorkflowHome,
  runBelongsToSession,
  workflowPosition,
} from '../src/services/workflowRuns.ts';
import type { WorkflowRunView } from '../src/types/webWorkflows.ts';

describe('workflowRuns', () => {
  it('resolves the registry home the way the engine does: env override, then ~/.workflow-mcp', () => {
    expect(resolveWorkflowHome({ envValue: '/custom/home', homeDir: '/h' })).toBe('/custom/home');
    expect(resolveWorkflowHome({ envValue: undefined, homeDir: '/h' })).toBe('/h/.workflow-mcp');
    expect(resolveWorkflowHome({ envValue: '', homeDir: '/h' })).toBe('/h/.workflow-mcp');
  });

  it('parses a run record the engine writes, typed against its published schema', () => {
    // Typing the fixture as the engine's own WorkflowRunRecord is the pin:
    // if @agimon-ai/workflow-mcp renames a field this mirror reads, this
    // fixture stops compiling. Values follow a real errored run observed in
    // ~/.workflow-mcp (an axx-wu-74 dev-full run).
    const record: WorkflowRunRecord = {
      displayName: 'AXX-WU-74',
      dryRun: false,
      env: { PI_SESSION_ID: '01a00eef-d11a-7a5a-afc6-a3eb14164011' },
      pid: 83102,
      runKey: 'axx-wu-74',
      stage: 'error',
      startedAt: '2026-08-17T21:13:28.133Z',
      finishedAt: '2026-08-17T22:34:28.391Z',
      outcome: 'failed',
      exitCode: 1,
      errorMessage: '\n\u001b[31m\u001b[1mworktree afterCompleted hook failed\u001b[0m',
      originalRepoPath: '/Users/dev/workspace/agirepo',
      workflowPath: '/Users/dev/workspace/agirepo/automations/workflows/dev-full.workflow.yml',
      workflowId: 'dev-full.workflow',
      workflowName: 'Development',
      workspace: 'agiflow',
      worktreeBranch: 'worktree/axx-wu-74',
    };
    const parsed = parseWorkflowRunRecord(JSON.stringify(record));
    expect(parsed?.view).toMatchObject({
      runKey: 'axx-wu-74',
      workspace: 'agiflow',
      displayName: 'AXX-WU-74',
      workflowName: 'Development',
      stage: 'error',
      outcome: 'failed',
      errorMessage: 'worktree afterCompleted hook failed',
      worktreeBranch: 'worktree/axx-wu-74',
      jobs: [],
    });
    expect(parsed?.piSessionId).toBe('01a00eef-d11a-7a5a-afc6-a3eb14164011');
    expect(parsed?.originalRepoPath).toBe('/Users/dev/workspace/agirepo');
  });

  it('rejects malformed or foreign records', () => {
    expect(parseWorkflowRunRecord('not json')).toBeUndefined();
    expect(parseWorkflowRunRecord('[]')).toBeUndefined();
    expect(parseWorkflowRunRecord(JSON.stringify({ runKey: 'x', workspace: 'w' }))).toBeUndefined();
    expect(
      parseWorkflowRunRecord(
        JSON.stringify({ runKey: 'x', workspace: 'w', workflowPath: '/p', startedAt: 'now', stage: 'archived' }),
      ),
    ).toBeUndefined();
  });

  it('folds the progress log into the job tree, pinned to observed real-world lines', () => {
    // Verbatim shape of a dev-fix.workflow.yml run's progress.ndjson, plus a
    // failing job to cover the terminal states.
    const events: WorkflowProgressEvent[] = [
      { type: 'job', status: 'running', job: 'diagnose', index: 0, total: 2, at: '2026-08-21T09:08:17.960Z' },
      {
        type: 'step',
        status: 'running',
        job: 'diagnose',
        step: 'Diagnose the defect',
        index: 0,
        total: 1,
        at: '2026-08-21T09:08:17.963Z',
      },
      {
        type: 'step',
        status: 'completed',
        job: 'diagnose',
        step: 'Diagnose the defect',
        at: '2026-08-21T09:08:17.964Z',
      },
      { type: 'job', status: 'completed', job: 'diagnose', at: '2026-08-21T09:08:17.964Z' },
      { type: 'job', status: 'running', job: 'fix', index: 1, total: 2, at: '2026-08-21T09:08:17.965Z' },
      { type: 'step', status: 'running', job: 'fix', step: 'Implement the fix', at: '2026-08-21T09:08:17.966Z' },
      {
        type: 'step',
        status: 'failed',
        job: 'fix',
        step: 'Implement the fix',
        reason: 'exit code 1',
        at: '2026-08-21T09:08:17.970Z',
      },
      { type: 'job', status: 'failed', job: 'fix', at: '2026-08-21T09:08:17.970Z' },
    ];
    const raw = events.map((event) => JSON.stringify(event)).join('\n');
    const jobs = foldWorkflowProgress(parseWorkflowProgress(raw));
    expect(jobs.map((job) => `${job.name}:${job.status}`)).toEqual(['diagnose:completed', 'fix:failed']);
    expect(jobs[0]).toMatchObject({
      phase: 'job',
      startedAt: '2026-08-21T09:08:17.960Z',
      endedAt: '2026-08-21T09:08:17.964Z',
    });
    expect(jobs[1]?.steps[0]).toMatchObject({ name: 'Implement the fix', status: 'failed', reason: 'exit code 1' });
  });

  it('skips a torn final line and classifies pre/post pseudo-jobs', () => {
    const raw = [
      JSON.stringify({ type: 'job', status: 'running', job: 'pre', at: '2026-08-21T09:00:00.000Z' }),
      JSON.stringify({ type: 'job', status: 'completed', job: 'pre', at: '2026-08-21T09:00:01.000Z' }),
      JSON.stringify({
        type: 'job',
        status: 'running',
        job: 'build',
        index: 0,
        total: 1,
        at: '2026-08-21T09:00:02.000Z',
      }),
      JSON.stringify({
        type: 'step',
        status: 'running',
        job: 'build',
        step: 'compile',
        at: '2026-08-21T09:00:03.000Z',
      }),
      '{"type":"step","status":"comp', // torn mid-append
    ].join('\n');
    const jobs = foldWorkflowProgress(parseWorkflowProgress(raw));
    expect(jobs.map((job) => job.phase)).toEqual(['pre', 'job']);
    expect(workflowPosition(jobs)).toEqual({ job: 'build', step: 'compile', index: 0, total: 1 });
  });

  it('scopes runs by owning session id or repository overlap', () => {
    const parsed = parseWorkflowRunRecord(
      JSON.stringify({
        runKey: 'r',
        workspace: 'w',
        workflowPath: '/repo/automations/wf.workflow.yml',
        startedAt: '2026-08-21T09:00:00.000Z',
        stage: 'running',
        originalRepoPath: '/repo',
        env: { PI_SESSION_ID: 'owner' },
      }),
    );
    expect(parsed).toBeDefined();
    if (!parsed) return;
    expect(runBelongsToSession(parsed, { sessionId: 'owner', cwd: '/elsewhere' })).toBe(true);
    expect(runBelongsToSession(parsed, { sessionId: 'other', cwd: '/repo' })).toBe(true);
    expect(runBelongsToSession(parsed, { sessionId: 'other', cwd: '/repo/packages/sub' })).toBe(true);
    expect(runBelongsToSession(parsed, { sessionId: 'other', cwd: '/repo-sibling' })).toBe(false);
  });

  it('presents running first, keeps errors a day, retires completed after ten minutes', () => {
    const run = (overrides: Partial<WorkflowRunView>): WorkflowRunView => ({
      runKey: 'r',
      workspace: 'w',
      displayName: 'r',
      workflowPath: '/repo/wf.yml',
      stage: 'running',
      startedAt: '2026-08-21T09:00:00.000Z',
      jobs: [],
      ...overrides,
    });
    const now = Date.parse('2026-08-21T10:00:00.000Z');
    const hourAgo = '2026-08-21T09:00:00.000Z';
    const justNow = '2026-08-21T09:55:00.000Z';
    const presented = presentWorkflowRuns(
      [
        run({ runKey: 'old-done', stage: 'completed', outcome: 'success', finishedAt: hourAgo }),
        run({ runKey: 'fresh-done', stage: 'completed', outcome: 'success', finishedAt: justNow }),
        run({ runKey: 'old-error', stage: 'error', outcome: 'failed', finishedAt: hourAgo }),
        run({ runKey: 'live', stage: 'running', startedAt: justNow }),
      ],
      now,
    );
    expect(presented.map((entry) => entry.runKey)).toEqual(['live', 'old-error', 'fresh-done']);
  });
});
