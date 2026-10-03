import type { WorkflowProgressEvent, WorkflowRunRecord } from '@agimon-ai/workflow-mcp';
import { describe, expect, it } from 'vitest';

import {
  foldWorkflowProgress,
  MAX_PRESENTED_WORKFLOW_RUNS_PER_GROUP,
  parseWorkflowProgress,
  parseWorkflowRunRecord,
  presentWorkflowRuns,
  resolveWorkflowHome,
  runLaunchedBySession,
  runBelongsToSession,
  workflowPosition,
} from '../src/services/workflowRuns';
import type { WorkflowRunView } from '../src/types/webWorkflows';

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

  it('keeps where a host executor ran a step after the step finishes', () => {
    const ref = { kind: 'session', id: 'child-session', label: 'dev-fix: diagnose > Diagnose' };
    const events: WorkflowProgressEvent[] = [
      { type: 'step', status: 'running', job: 'diagnose', step: 'Diagnose', at: '2026-09-27T10:00:00.000Z' },
      { type: 'step', status: 'running', job: 'diagnose', step: 'Diagnose', ref, at: '2026-09-27T10:00:01.000Z' },
      { type: 'step', status: 'completed', job: 'diagnose', step: 'Diagnose', at: '2026-09-27T10:05:00.000Z' },
    ];
    // A malformed ref inside the same attempt is skipped, not taken for a new one.
    const raw = [
      JSON.stringify(events[0]),
      JSON.stringify(events[1]),
      JSON.stringify({ ...events[1], ref: { kind: 'session' } }),
      JSON.stringify(events[2]),
    ].join('\n');
    const [job] = foldWorkflowProgress(parseWorkflowProgress(raw));
    expect(job?.steps).toEqual([expect.objectContaining({ name: 'Diagnose', status: 'completed', ref })]);
  });

  it('forgets the previous attempt of a step that starts again', () => {
    const ref = { kind: 'session', id: 'child-session', label: 'Diagnose' };
    const events: WorkflowProgressEvent[] = [
      { type: 'step', status: 'running', job: 'diagnose', step: 'Diagnose', ref, at: '2026-09-27T10:00:00.000Z' },
      {
        type: 'step',
        status: 'failed',
        job: 'diagnose',
        step: 'Diagnose',
        reason: 'artifact missing',
        at: '2026-09-27T10:05:00.000Z',
      },
      { type: 'step', status: 'running', job: 'diagnose', step: 'Diagnose', at: '2026-09-27T10:06:00.000Z' },
    ];
    const [job] = foldWorkflowProgress(parseWorkflowProgress(events.map((event) => JSON.stringify(event)).join('\n')));

    // Until the new attempt records its session, there is none to show or guide.
    expect(job?.steps).toEqual([{ name: 'Diagnose', status: 'running', startedAt: '2026-09-27T10:06:00.000Z' }]);
  });

  it.each(['running', 'failed'] as const)('resets indexed recovery attempts after %s', (status) => {
    const ref = { kind: 'session', id: 'old-session' };
    const start: WorkflowProgressEvent = {
      type: 'step',
      status: 'running',
      job: 'fix',
      step: 'Fix',
      index: 0,
      at: 'start',
    };
    const events: WorkflowProgressEvent[] = [
      { type: 'job', status: 'running', job: 'fix', index: 0, at: 'start' },
      start,
      { ...start, index: undefined, ref, at: 'session' },
      { ...start, index: undefined, status, reason: 'old reason', at: 'interrupted' },
      { type: 'job', status, job: 'fix', reason: 'old reason', at: 'interrupted' },
      { type: 'job', status: 'running', job: 'fix', index: 0, at: 'restart' },
      { ...start, at: 'restart' },
    ];
    const fold = () =>
      foldWorkflowProgress(parseWorkflowProgress(events.map((event) => JSON.stringify(event)).join('\n')));
    expect(fold()).toEqual([
      {
        name: 'fix',
        phase: 'job',
        status: 'running',
        index: 0,
        startedAt: 'restart',
        steps: [{ name: 'Fix', status: 'running', startedAt: 'restart' }],
      },
    ]);
    const replacement = { kind: 'session', id: 'replacement' };
    events.push({ ...start, index: undefined, ref: replacement, at: 'replacement' });
    events.push({ ...start, index: undefined, at: 'update' });
    expect(fold()[0]?.steps).toEqual([{ name: 'Fix', status: 'running', startedAt: 'restart', ref: replacement }]);
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

  it('keeps recorded work missing from the plan and marks unstarted steps in skipped jobs as skipped', () => {
    const plan = [
      {
        name: 'build',
        phase: 'job' as const,
        status: 'pending' as const,
        steps: [{ name: 'compile', status: 'pending' as const }],
      },
    ];
    const events = parseWorkflowProgress(
      [
        { type: 'job', status: 'skipped', job: 'build', reason: 'condition was false', at: 'now' },
        { type: 'step', status: 'completed', job: 'legacy', step: 'old step', at: 'now' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    );
    expect(foldWorkflowProgress(events, plan)).toMatchObject([
      { name: 'build', status: 'skipped', steps: [{ name: 'compile', status: 'skipped' }] },
      { name: 'legacy', status: 'completed', steps: [{ name: 'old step', status: 'completed' }] },
    ]);
    expect(plan[0]?.steps[0]?.status).toBe('pending');
  });

  it('scopes runs to the session that launched them, never to the repository', () => {
    const record = (env?: Record<string, string>): string =>
      JSON.stringify({
        runKey: 'r',
        workspace: 'w',
        workflowPath: '/repo/automations/wf.workflow.yml',
        startedAt: '2026-08-21T09:00:00.000Z',
        stage: 'running',
        originalRepoPath: '/repo',
        ...(env === undefined ? {} : { env }),
      });

    const owned = parseWorkflowRunRecord(record({ PI_SESSION_ID: 'owner' }));
    expect(owned).toBeDefined();
    if (!owned) return;
    expect(runBelongsToSession(owned, 'owner')).toBe(true);
    // The repository the run came from buys another session nothing: two
    // sessions open in one repo must not read each other's history.
    expect(runBelongsToSession(owned, 'other')).toBe(false);

    // An unstamped record is a launch from the CLI rather than from a session,
    // so it belongs to nobody rather than to everybody in that repo.
    const unowned = parseWorkflowRunRecord(record());
    expect(unowned).toBeDefined();
    if (!unowned) return;
    expect(unowned.piSessionId).toBeUndefined();
    expect(runBelongsToSession(unowned, 'owner')).toBe(false);

    // A run handed to a workflow session names both: its owner runs it, its launcher lists it.
    const handed = parseWorkflowRunRecord(
      record({ PI_SESSION_ID: 'child', DOOMPI_WORKFLOW_LAUNCHER_SESSION_ID: 'parent' }),
    );
    expect(handed?.view).toMatchObject({ ownerSessionId: 'child', launcherSessionId: 'parent' });
    expect(handed && runBelongsToSession(handed, 'child')).toBe(true);
    expect(handed && runLaunchedBySession(handed, 'parent')).toBe(true);
    expect(handed && runLaunchedBySession(handed, 'child')).toBe(false);
  });

  it('presents running first, keeps errors a day, and keeps finished runs for the session', () => {
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
    // An hour-old success is exactly what a reader asks about later in the day,
    // so it stays; only the errored run has a retention of its own.
    expect(presented.map((entry) => entry.runKey)).toEqual(['live', 'old-error', 'fresh-done', 'old-done']);
  });

  it('retires an errored run once its day is up', () => {
    const dayOld = '2026-08-20T08:00:00.000Z';
    const presented = presentWorkflowRuns(
      [
        {
          runKey: 'stale-error',
          workspace: 'w',
          displayName: 'r',
          workflowPath: '/repo/wf.yml',
          stage: 'error',
          startedAt: dayOld,
          finishedAt: dayOld,
          jobs: [],
        },
      ],
      Date.parse('2026-08-21T10:00:00.000Z'),
    );
    expect(presented).toEqual([]);
  });

  // One cap across every run let a stream of green runs push a failure out of
  // the list, which is the one thing that must never fall off the end.
  it('caps each outcome group on its own so a failure cannot be crowded out', () => {
    const many = Array.from({ length: MAX_PRESENTED_WORKFLOW_RUNS_PER_GROUP + 6 }, (_, index) => ({
      runKey: `done-${index}`,
      workspace: 'w',
      displayName: 'r',
      workflowPath: '/repo/wf.yml',
      stage: 'completed' as const,
      outcome: 'success' as const,
      startedAt: new Date(Date.parse('2026-08-21T09:00:00.000Z') + index).toISOString(),
      jobs: [],
    }));
    const failure: WorkflowRunView = {
      runKey: 'failed-one',
      workspace: 'w',
      displayName: 'r',
      workflowPath: '/repo/wf.yml',
      stage: 'error',
      startedAt: '2026-08-21T09:30:00.000Z',
      finishedAt: '2026-08-21T09:31:00.000Z',
      jobs: [],
    };
    const presented = presentWorkflowRuns([...many, failure], Date.parse('2026-08-21T10:00:00.000Z'));
    expect(presented[0]?.runKey).toBe('failed-one');
    expect(presented.filter((entry) => entry.stage === 'completed')).toHaveLength(
      MAX_PRESENTED_WORKFLOW_RUNS_PER_GROUP,
    );
  });
});
