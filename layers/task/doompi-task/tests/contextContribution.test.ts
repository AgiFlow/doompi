import { describe, expect, it } from 'vitest';
import {
  createTaskContextContribution,
  TASK_CONTEXT_CONTRIBUTION_ID,
  TASK_CONTEXT_CONTRIBUTION_LABEL,
  TASK_CONTEXT_CONTRIBUTION_ORDER,
  TASK_CONTEXT_CONTRIBUTION_SOURCE,
} from '../src/services/contextContribution.ts';
import type { Task } from '../src/services/store/types.ts';

describe('Task context contribution', () => {
  it('renders only active coordination fields from the current in-memory snapshot', () => {
    let tasks: Task[] = [
      {
        id: 8,
        subject: 'Resume implementation',
        description: 'Private implementation detail',
        activeForm: 'Implementing runtime state',
        status: 'in_progress',
        owner: 'main',
        blockedBy: [4],
        metadata: { secret: 'do not expose' },
        delegation: {
          requestId: 'request-8',
          agent: 'worker',
          state: 'failed',
          result: { status: 'failed', error: 'worker stopped', output: 'private delegated output' },
        },
      },
      { id: 9, subject: 'Finished task', description: 'old detail', status: 'completed' },
    ];
    const contribution = createTaskContextContribution(() => tasks);

    expect(contribution).toMatchObject({
      source: TASK_CONTEXT_CONTRIBUTION_SOURCE,
      id: TASK_CONTEXT_CONTRIBUTION_ID,
      label: TASK_CONTEXT_CONTRIBUTION_LABEL,
      order: TASK_CONTEXT_CONTRIBUTION_ORDER,
    });
    expect(contribution.snapshot()).toBe(
      '- #8 [in_progress] Resume implementation | active: Implementing runtime state | owner: main | blocked by: 4 | delegation: worker (failed) | error: worker stopped',
    );
    expect(contribution.snapshot()).not.toContain('Private implementation detail');
    expect(contribution.snapshot()).not.toContain('do not expose');
    expect(contribution.snapshot()).not.toContain('private delegated output');
    expect(contribution.snapshot()).not.toContain('Finished task');

    tasks = [{ id: 10, subject: 'Replacement snapshot', status: 'pending' }];
    expect(contribution.snapshot()).toBe('- #10 [pending] Replacement snapshot');
  });

  it('reports an explicit empty snapshot instead of omitting Task state', () => {
    expect(createTaskContextContribution(() => []).snapshot()).toBe('(no active tasks)');
  });
});
