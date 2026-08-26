import { describe, expect, it } from 'vitest';
import type { WorkflowRunView } from '../src/types/webWorkflows.ts';
import { workflowActivityRows, workflowRunIdentity } from '../web/workflowActivity.ts';
import { focusRun, workflowRunsChannel, workflows } from '../web/workflowsStore.ts';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');

function run(overrides: Partial<WorkflowRunView>): WorkflowRunView {
  return {
    runKey: 'release',
    workspace: 'default',
    displayName: 'Release',
    workflowPath: '/wf/release.yaml',
    stage: 'running',
    startedAt: '2026-08-24T11:30:00.000Z',
    jobs: [],
    ...overrides,
  };
}

describe('workflow activity rows', () => {
  it('describes where each run is, in the hub order', () => {
    const rows = workflowActivityRows(
      [
        run({ position: { job: 'build', step: 'edit src/x.ts' } }),
        run({ runKey: 'starting', displayName: 'Starting' }),
        run({ runKey: 'paused', displayName: 'Paused', executionState: 'paused' }),
        run({
          runKey: 'boom',
          displayName: 'Boom',
          stage: 'error',
          errorMessage: 'step 3 failed',
          finishedAt: '2026-08-24T11:45:00.000Z',
        }),
        run({
          runKey: 'done',
          displayName: 'Done',
          stage: 'completed',
          outcome: 'success',
          finishedAt: '2026-08-24T11:31:00.000Z',
        }),
        run({ runKey: 'skipped', displayName: 'Skipped', stage: 'completed', outcome: 'skipped' }),
      ],
      NOW,
    );
    expect(rows.map((row) => [row.runKey, row.tone, row.detail, row.elapsed])).toEqual([
      ['release', 'running', 'build · edit src/x.ts', '30m'],
      ['starting', 'running', 'starting', '30m'],
      ['paused', 'paused', 'paused; resume it from the owning session', '30m'],
      ['boom', 'failed', 'step 3 failed', '15m'],
      ['done', 'done', 'success', '1m'],
      ['skipped', 'skipped', 'skipped', '30m'],
    ]);
    expect(rows[0]?.identity).toBe(workflowRunIdentity(run({})));
  });

  it('keeps the focused run per session and drops it with the session', () => {
    workflows.reset();
    const focused = () => workflows.select(workflows.store.state, 's1').focusedRun;
    workflowRunsChannel.apply('s1', workflowRunsChannel.parse({ runs: [run({})] })!);
    focusRun('s1', 'default/release');
    expect(focused()).toBe('default/release');
    // A feed update keeps the focus.
    workflowRunsChannel.apply('s1', workflowRunsChannel.parse({ runs: [run({})] })!);
    expect(focused()).toBe('default/release');
    workflowRunsChannel.drop('s1');
    expect(focused()).toBeUndefined();
    workflows.reset();
  });
});
