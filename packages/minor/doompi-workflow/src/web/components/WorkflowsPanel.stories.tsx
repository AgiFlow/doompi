/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The slot props come from the contracts package's own testing
 * fixture rather than a hand-rolled stub.
 *
 * The panel renders whatever the workflow registry channel last reported, so
 * the story seeds the same store that channel writes into, exactly as
 * WorkflowsActivitySection.stories.tsx does.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';

import type { WorkflowRunView } from '../../types/webWorkflows';
import { workflows } from '../stores/workflowsStore';
import { WorkflowsPanel } from './WorkflowsPanel';

/** Its own session id, so seeding this store cannot disturb another story's. */
const SESSION_ID = 'workflows-panel';
const EMPTY_SESSION_ID = 'workflows-panel-empty';
const MINUTE_MS = 60_000;

const run = (
  overrides: Partial<WorkflowRunView> & Pick<WorkflowRunView, 'runKey' | 'displayName'>,
): WorkflowRunView => ({
  workspace: 'doompi',
  workflowPath: '.doom/workflows/release.workflow.yaml',
  stage: 'running',
  startedAt: new Date(Date.now() - 7 * MINUTE_MS).toISOString(),
  jobs: [],
  ...overrides,
});

workflows.update(SESSION_ID, (current) => ({
  ...current,
  runs: [
    run({ runKey: 'release-14', displayName: 'release', position: { job: 'build', step: 'pnpm build' } }),
    run({ runKey: 'nightly-14', displayName: 'nightly', executionState: 'paused' }),
    run({
      runKey: 'release-13',
      displayName: 'release',
      stage: 'error',
      outcome: 'failed',
      errorMessage: "job 'test' exited 1",
      startedAt: new Date(Date.now() - 52 * MINUTE_MS).toISOString(),
      finishedAt: new Date(Date.now() - 40 * MINUTE_MS).toISOString(),
    }),
    run({
      runKey: 'hotfix-12',
      displayName: 'hotfix',
      stage: 'completed',
      outcome: 'success',
      startedAt: new Date(Date.now() - 95 * MINUTE_MS).toISOString(),
      finishedAt: new Date(Date.now() - 90 * MINUTE_MS).toISOString(),
    }),
  ],
}));

const props = (sessionId: string) => slotPropsFixture({ sessionId }).props;

const meta = {
  title: 'Workflow/WorkflowsPanel',
  component: WorkflowsPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          running, paused, failed and successful runs
        </span>
        <div className="h-96 w-full rounded-md border border-doom-border bg-doom-panel">
          <WorkflowsPanel {...props(SESSION_ID)} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no runs yet</span>
        <div className="h-64 w-full rounded-md border border-doom-border bg-doom-panel">
          <WorkflowsPanel {...props(EMPTY_SESSION_ID)} />
        </div>
      </div>
    </div>
  ),
};
