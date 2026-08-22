import type { WorkflowStage } from '@agimon-ai/workflow-mcp';
import { describe, expect, it, vi } from 'vitest';
import { narrateWorkflowTransition, type WorkflowNarrationSink } from '../../src/services/workflowNarration.ts';

function requester() {
  return { narrate: vi.fn() } satisfies WorkflowNarrationSink;
}

function workflow(stage: WorkflowStage) {
  return { displayName: 'Authentication', stage };
}

describe('workflow narration publisher', () => {
  it('announces a workflow first observed running after the session starts', () => {
    const speech = requester();

    narrateWorkflowTransition(speech, workflow('running'), undefined, true);

    expect(speech.narrate).toHaveBeenCalledOnce();
    expect(speech.narrate).toHaveBeenCalledWith('Workflow launched: Authentication.');
  });

  it('announces successful and failed terminal transitions', () => {
    const speech = requester();

    narrateWorkflowTransition(speech, workflow('completed'), 'running', false);
    narrateWorkflowTransition(speech, workflow('error'), 'running', false);

    expect(speech.narrate.mock.calls).toEqual([
      ['Workflow succeeded: Authentication.'],
      ['Workflow failed: Authentication.'],
    ]);
  });

  it('announces both lifecycle moments when a fast workflow is first observed terminal', () => {
    const speech = requester();

    narrateWorkflowTransition(speech, workflow('completed'), undefined, true);

    expect(speech.narrate.mock.calls).toEqual([
      ['Workflow launched: Authentication.'],
      ['Workflow succeeded: Authentication.'],
    ]);
  });

  it('ignores historical runs and unchanged stages', () => {
    const speech = requester();

    narrateWorkflowTransition(speech, workflow('running'), undefined, false);
    narrateWorkflowTransition(speech, workflow('completed'), 'completed', false);
    narrateWorkflowTransition(speech, workflow('error'), 'error', false);

    expect(speech.narrate).not.toHaveBeenCalled();
  });
});
