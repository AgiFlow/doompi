import { describe, expect, it } from 'vitest';
import { workflowRunsChannel, workflows } from '../web/workflowsStore.ts';

describe('the workflows web store channel', () => {
  it('keeps each session workflow set separately and drops one with its session', () => {
    workflows.reset();
    const run = { runKey: 'wf-1', workspace: 'w', displayName: 'wf-1', stage: 'running', jobs: [] };
    workflowRunsChannel.apply('s1', workflowRunsChannel.parse({ runs: [run] })!);
    workflowRunsChannel.apply('s2', workflowRunsChannel.parse({ runs: [] })!);
    expect(workflows.select(workflows.store.state, 's1').runs).toHaveLength(1);
    expect(workflows.select(workflows.store.state, 's2').runs).toEqual([]);

    workflowRunsChannel.drop('s1');
    expect(workflows.store.state.s1).toBeUndefined();
    // Malformed payloads are rejected at the parse gate.
    expect(workflowRunsChannel.parse('junk')).toBeNull();
    expect(workflowRunsChannel.parse({ runs: 'no' })).toBeNull();
    workflows.reset();
  });
});
