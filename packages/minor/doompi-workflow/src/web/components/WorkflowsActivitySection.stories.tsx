/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the slot contract breaks this
 * story at the type level instead of silently drifting.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';
import type { WorkflowRunView } from '../../types/webWorkflows';
import { workflows } from '../stores/workflowsStore';
import { WorkflowsActivitySection } from './WorkflowsActivitySection';

/** Its own session id, so a story that seeds this store cannot disturb another's. */
const SESSION_ID = 'workflows-activity';
const IDLE_SESSION_ID = 'workflows-activity-idle';
const MINUTE_MS = 60_000;

const run = (
  overrides: Partial<WorkflowRunView> & Pick<WorkflowRunView, 'runKey' | 'displayName'>,
): WorkflowRunView => ({
  workspace: 'doompi',
  workflowPath: '.doom/workflows/release.workflow.yaml',
  stage: 'running',
  // Relative, so the elapsed time each row prints stays a plausible few minutes.
  startedAt: new Date(Date.now() - 7 * MINUTE_MS).toISOString(),
  jobs: [],
  ...overrides,
});

// The dock renders whatever the workflow registry channel last reported, so
// the story seeds the same store that channel writes into.
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
      finishedAt: new Date(Date.now() - 40 * MINUTE_MS).toISOString(),
      startedAt: new Date(Date.now() - 52 * MINUTE_MS).toISOString(),
    }),
    run({
      runKey: 'hotfix-12',
      displayName: 'hotfix',
      stage: 'completed',
      outcome: 'success',
      finishedAt: new Date(Date.now() - 90 * MINUTE_MS).toISOString(),
      startedAt: new Date(Date.now() - 95 * MINUTE_MS).toISOString(),
    }),
    run({
      runKey: 'nightly-11',
      displayName: 'nightly',
      stage: 'completed',
      outcome: 'skipped',
      finishedAt: new Date(Date.now() - 300 * MINUTE_MS).toISOString(),
      startedAt: new Date(Date.now() - 301 * MINUTE_MS).toISOString(),
    }),
  ],
}));

const props = (sessionId: string) => slotPropsFixture({ sessionId }).props;

const meta = {
  title: 'Workflow/WorkflowsActivitySection',
  component: WorkflowsActivitySection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          running and failed open, successful folded · at the dock's width
        </span>
        <div className="w-72 rounded-md border border-doom-border bg-doom-panel p-2">
          <WorkflowsActivitySection {...props(SESSION_ID)} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">idle</span>
        <div className="w-72 rounded-md border border-doom-border bg-doom-panel p-2">
          <WorkflowsActivitySection {...props(IDLE_SESSION_ID)} />
        </div>
      </div>
    </div>
  ),
};
