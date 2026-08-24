import { describe, expect, it } from 'vitest';
import { resetWorkflows, workflowRunsChannel, workflowsStore } from '../web/workflowsStore.ts';

describe('the workflows web store channel', () => {
  it('keeps each session workflow set separately and drops one with its session', () => {
    resetWorkflows();
    const run = { runKey: 'wf-1', workspace: 'w', displayName: 'wf-1', stage: 'running', jobs: [] };
    workflowRunsChannel.apply('s1', workflowRunsChannel.parse({ runs: [run] })!);
    workflowRunsChannel.apply('s2', workflowRunsChannel.parse({ runs: [] })!);
    expect(workflowsStore.state.bySession.s1).toHaveLength(1);
    expect(workflowsStore.state.bySession.s2).toEqual([]);

    workflowRunsChannel.drop('s1');
    expect(workflowsStore.state.bySession.s1).toBeUndefined();
    // Malformed payloads are rejected at the parse gate.
    expect(workflowRunsChannel.parse('junk')).toBeNull();
    expect(workflowRunsChannel.parse({ runs: 'no' })).toBeNull();
    resetWorkflows();
  });
});
