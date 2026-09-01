import { describe, expect, it } from 'vitest';
import { workflowCallSummary, workflowResultLines } from '../src/web/workflowToolRender.ts';

const text = (value: string) => ({ content: [{ type: 'text', text: value }], details: undefined });
const json = (value: unknown) => text(JSON.stringify(value));
const done = { expanded: false, isError: false, isPartial: false };
const expanded = { ...done, expanded: true };
const texts = (lines: Array<{ text: string }>) => lines.map((entry) => entry.text);

describe('workflow tool call summaries', () => {
  it('names the action, target, and flags per tool', () => {
    expect(
      workflowCallSummary('list_workflows', { directory: '/wf', page: 2, pageSize: 5, filter: 'x', tags: ['a'] }),
    ).toEqual({ action: 'list', target: '/wf', metadata: ['page 2', '5/page', 'filtered', '1 tag'] });
    expect(
      workflowCallSummary('launch_workflow', {
        workflowPath: '/wf/release.workflow.yaml',
        workspace: 'ws',
        job: 'build',
        runner: 'local',
        dryRun: true,
        prompt: 'go',
        inputs: { a: 1, b: 2 },
        env: { X: '1' },
      }),
    ).toEqual({
      action: 'launch',
      target: '/wf/release.workflow.yaml',
      metadata: ['workspace ws', 'job build', 'runner local', 'dry run', 'with prompt', '2 inputs', '1 env'],
    });
    expect(
      workflowCallSummary('workflow_run', {
        action: 'stop',
        runKey: 'r1',
        workspace: 'ws',
        expectedRunId: 'g1',
        reason: 'user',
        dryRun: true,
        job: 'j',
        runner: 'x',
      }),
    ).toEqual({
      action: 'stop',
      target: 'ws/r1',
      metadata: ['generation checked', 'with reason', 'dry run', 'job override', 'runner override'],
    });
    expect(workflowCallSummary('workflow_run', {})).toEqual({ action: 'run', metadata: [] });
  });
});

describe('workflow tool result lines', () => {
  it('shows the tail while partial and the failure while errored', () => {
    const partial = workflowResultLines('workflow_run', { action: 'status', runKey: 'r1' }, text('a\nb\nc\nd\ne\nf'), {
      ...done,
      isPartial: true,
    });
    expect(texts(partial)).toEqual(['◐ status · r1', '… 2 earlier', 'c', 'd', 'e', 'f']);
    expect(partial[0]?.tone).toBe('accent');

    const failed = workflowResultLines('launch_workflow', { workflowPath: '/wf/x.yaml' }, text(''), {
      ...done,
      isError: true,
    });
    expect(texts(failed)).toEqual(['✗ launch failed · /wf/x.yaml', 'Unknown workflow error']);
    const many = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n');
    expect(texts(workflowResultLines('list_workflows', {}, text(many), { ...done, isError: true })).at(-1)).toBe(
      '… 2 more',
    );
  });

  it('lists the catalog, collapsing rows until expanded', () => {
    const workflows = Array.from({ length: 8 }, (_, index) => ({
      name: index === 0 ? '' : `wf${index}`,
      path: `/wf/wf${index}.workflow.yaml`,
      description: `does ${index}`,
      tags: ['t'],
    }));
    const payload = { workflows, tags: [{ tag: 't', count: 8 }], total: 8, page: 1, totalPages: 1, directory: '/wf' };
    const collapsed = texts(workflowResultLines('list_workflows', {}, json(payload), done));
    expect(collapsed[0]).toBe('✓ 8 workflows · page 1/1');
    expect(collapsed[1]).toBe('› wf0 · /wf/wf0.workflow.yaml');
    expect(collapsed).toHaveLength(8);
    expect(collapsed.at(-1)).toBe('… 2 more');

    const full = texts(workflowResultLines('list_workflows', {}, json(payload), expanded));
    expect(full).toContain('does 3');
    expect(full).toContain('available tags t (8)');
    expect(full).toContain('directory /wf');
    expect(full.at(-1)).toBe('page size 8');
    expect(texts(workflowResultLines('list_workflows', {}, json({ workflows: [] }), done))).toEqual([
      '○ 0 workflows · page 1/0',
    ]);
    // A non-catalog body falls back to the text.
    expect(texts(workflowResultLines('list_workflows', {}, text('plain'), done))).toEqual(['plain']);
    expect(texts(workflowResultLines('list_workflows', {}, null, done))).toEqual(['No workflow output.']);
  });

  it('summarises a launch from the text the tool returns', () => {
    const launched = text('Started Release in workspace ws.\nRun key: r9\nNext steps for the agent: poll');
    const lines = workflowResultLines('launch_workflow', { job: 'b', runner: 'x', dryRun: true }, launched, expanded);
    expect(texts(lines)).toEqual([
      '◐ Release · ws/r9 · started',
      'job b · runner x · dry run',
      'Started Release in workspace ws.',
      'Run key: r9',
    ]);
    const outcomes: Array<[string, string]> = [
      ['Workflow completed successfully', '✓ x · /wf/x.workflow.yaml · completed'],
      ['Workflow skipped', '○ x · /wf/x.workflow.yaml · skipped'],
      ['no run was registered', '◐ x · /wf/x.workflow.yaml · starting · run key pending'],
      ['accepted', '◐ x · /wf/x.workflow.yaml · launch accepted'],
    ];
    for (const [body, heading] of outcomes) {
      expect(
        texts(workflowResultLines('launch_workflow', { workflowPath: '/wf/x.workflow.yaml' }, text(body), done))[0],
      ).toBe(heading);
    }
  });

  it('renders a status record with its state, activity, and detail rows', () => {
    const record = {
      runKey: 'r1',
      workspace: 'ws',
      displayName: 'Release',
      stage: 'running',
      executionCursor: { job: 'build', stepName: 'compile' },
      runner: 'local',
      dryRun: true,
      exitCode: 0,
      startedAt: '2026-08-24T10:00:00.000Z',
      workflowPath: '/wf/r.yaml',
      workflowId: 'wid',
      runId: 'rid',
      launcher: { type: 'pi', sessionName: 's1' },
      job: 'build',
      outcome: 'pending',
      finishedAt: '2026-08-24T11:00:00.000Z',
      pid: 42,
      activeRepairId: 'rep',
      worktreeBranch: 'fix',
    };
    const collapsed = texts(workflowResultLines('workflow_run', { action: 'status' }, json(record), done));
    expect(collapsed).toEqual([
      '◐ Release · ws/r1 · running',
      '[build] compile',
      'runner local · dry run · exit 0 · started 2026-08-24 10:00:00Z',
    ]);
    const full = texts(workflowResultLines('workflow_run', { action: 'status' }, json(record), expanded));
    expect(full).toContain('launcher pi s1');
    expect(full).toContain('finished 2026-08-24 11:00:00Z');
    expect(full).toContain('repair #rep');
    expect(full).toContain('worktree fix');
    expect(full).toContain('pid 42');

    const states: Array<[Record<string, unknown>, string]> = [
      [{ outcome: 'interrupted' }, '! r · r · interrupted'],
      [{ stage: 'error' }, '✗ r · r · failed'],
      [{ stage: 'completed', outcome: 'skipped' }, '○ r · r · skipped'],
      [{ stage: 'completed' }, '✓ r · r · completed'],
      [{ executionState: 'paused' }, 'Ⅱ r · r · paused'],
      [{ executionState: 'pause_requested' }, '◐ r · r · pause requested'],
      [{ executionState: 'resume_requested' }, '◐ r · r · resume requested'],
      [{ stage: 'queued' }, '○ r · r · queued'],
    ];
    for (const [overrides, heading] of states) {
      const lines = workflowResultLines(
        'workflow_run',
        { action: 'status' },
        json({ runKey: 'r', stage: 'running', errorMessage: 'boom', staleReason: 'old', ...overrides }),
        done,
      );
      expect(texts(lines)[0]).toBe(heading);
      expect(texts(lines)).toContain('error boom');
      expect(texts(lines)).toContain('stale old');
    }
    // A status body without a run record falls back to the text.
    expect(texts(workflowResultLines('workflow_run', { action: 'status' }, json({ other: 1 }), done))).toEqual([
      '{"other":1}',
    ]);
    expect(texts(workflowResultLines('workflow_run', { action: 'status' }, text('not json'), done))).toEqual([
      'not json',
    ]);
  });

  it('describes control, recovery, and simple actions', () => {
    const control = workflowResultLines(
      'workflow_run',
      { action: 'pause', runKey: 'r1' },
      json({ workspace: 'ws', request: { requestedAt: '2026-08-24T10:00:00.000Z' } }),
      expanded,
    );
    expect(texts(control)).toEqual([
      '◐ pause requested · ws/r1',
      'requested 2026-08-24 10:00:00Z',
      'verify the transition with workflow_run status',
    ]);
    expect(texts(workflowResultLines('workflow_run', { action: 'stop' }, json({ runKey: 'k' }), done))).toEqual([
      '◐ stop requested · k',
    ]);

    const evidence = text(
      ['--- run.json ---', JSON.stringify({ runKey: 'r1', stage: 'error' }), '--- issue.md ---', 'it broke', ''].join(
        '\n',
      ),
    );
    const recovery = workflowResultLines(
      'workflow_run',
      { action: 'recovery-evidence', runKey: 'r1' },
      evidence,
      expanded,
    );
    expect(texts(recovery)).toEqual(['✗ r1 · r1 · failed', 'evidence issue.md', 'issue.md', 'it broke']);
    expect(
      texts(workflowResultLines('workflow_run', { action: 'recovery-evidence', runKey: 'r1' }, text('nothing'), done)),
    ).toEqual(['✓ recovery evidence · r1', 'no durable evidence files recorded']);

    const tail = workflowResultLines(
      'workflow_run',
      { action: 'tail', runKey: 'r1' },
      text('Workflow: Release\nStage: running\nRaw output hidden'),
      done,
    );
    expect(texts(tail)).toEqual(['✓ launcher output checked · r1', 'Workflow: Release', 'Stage: running']);
    expect(
      texts(workflowResultLines('workflow_run', { action: 'recover', dryRun: true }, text('ok'), expanded)),
    ).toEqual(['◐ recovery dry run finished · workflow', 'ok']);
    expect(texts(workflowResultLines('workflow_run', { action: 'follow' }, text(''), done))).toEqual([
      '✓ following output · workflow',
    ]);
    expect(texts(workflowResultLines('workflow_run', { action: 'open' }, text(''), done))).toEqual([
      '✓ launcher opened · workflow',
    ]);
    expect(texts(workflowResultLines('workflow_run', { action: 'mystery' }, text('a\nb'), done))).toEqual(['a', 'b']);
  });
});
