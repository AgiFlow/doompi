import { describe, expect, it } from 'vitest';

import { stepSessionRef } from '../../src/extensions/workspaces/sessions/(frontend)/_components/StepTerminalPanel';
import type { WorkflowRunView } from '../../src/types/webWorkflows';

const SESSION = { kind: 'session', id: 'child-session' };
const PANE = { kind: 'pane', id: 'doom-runner-1' };

function run(steps: WorkflowRunView['jobs'][number]['steps']): WorkflowRunView {
  return {
    runKey: 'r1',
    workspace: 'w',
    displayName: 'r1',
    workflowPath: '/repo/wf.yml',
    stage: 'running',
    startedAt: 'now',
    jobs: [{ name: 'build', phase: 'job', status: 'running', steps }],
  };
}

describe('stepSessionRef', () => {
  it('follows the named step when it ran as a session, finished or not', () => {
    const view = run([
      { name: 'Diagnose', status: 'completed', ref: SESSION },
      { name: 'Install', status: 'running', ref: PANE },
    ]);
    expect(stepSessionRef(view, { workspace: 'w', runKey: 'r1', job: 'build', step: 'Diagnose' })).toEqual(SESSION);
    expect(stepSessionRef(view, { workspace: 'w', runKey: 'r1', job: 'build', step: 'Install' })).toBeUndefined();
  });

  it('follows only the latest step for a job tab', () => {
    const job = { workspace: 'w', runKey: 'r1', job: 'build' };
    expect(stepSessionRef(run([{ name: 'Diagnose', status: 'running', ref: SESSION }]), job)).toEqual(SESSION);
    expect(
      stepSessionRef(
        run([
          { name: 'Diagnose', status: 'completed', ref: SESSION },
          { name: 'Install', status: 'running', ref: PANE },
        ]),
        job,
      ),
    ).toBeUndefined();
    expect(stepSessionRef(undefined, job)).toBeUndefined();
  });
});
