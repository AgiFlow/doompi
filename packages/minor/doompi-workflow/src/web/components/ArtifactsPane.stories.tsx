/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition.
 *
 * The pane reads its listing from the workflow API inside an effect. The
 * headless renderer has no backend, so the request fails and the pane shows
 * the states it reaches without one. The rows themselves are covered by
 * WorkflowsPanel, which reads the same registry from a seeded store.
 */
import type { WorkflowRunView } from '../../types/webWorkflows';
import { ArtifactsPane } from './ArtifactsPane';

const MINUTE_MS = 60_000;

const run: WorkflowRunView = {
  runKey: 'release-14',
  workspace: 'doompi',
  displayName: 'release',
  workflowPath: '.doom/workflows/release.workflow.yaml',
  stage: 'completed',
  outcome: 'success',
  startedAt: new Date(Date.now() - 12 * MINUTE_MS).toISOString(),
  finishedAt: new Date(Date.now() - 4 * MINUTE_MS).toISOString(),
  jobs: [],
};

const meta = {
  title: 'Workflow/ArtifactsPane',
  component: ArtifactsPane,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          a finished run · listing unavailable without a backend
        </span>
        <div className="w-96 rounded-md border border-doom-border bg-doom-panel">
          <ArtifactsPane run={run} sessionId="artifacts-pane" onOpen={() => undefined} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no session</span>
        <div className="w-96 rounded-md border border-doom-border bg-doom-panel">
          <ArtifactsPane run={run} sessionId={null} onOpen={() => undefined} />
        </div>
      </div>
    </div>
  ),
};
