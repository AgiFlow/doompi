/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the slot contract breaks this
 * story at the type level instead of silently drifting.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { WorkflowCatalogEntryView } from '../../types/webWorkflows';
import { LaunchWorkflowDialog } from './LaunchWorkflowDialog';

const SESSION_ID = 'workflow-launch';
const CWD = '/Users/doom/workspace/doompi';

const RELEASE: WorkflowCatalogEntryView = {
  path: `${CWD}/automations/workflows/release.workflow.yaml`,
  relativePath: 'automations/workflows/release.workflow.yaml',
  name: 'release',
  description: 'Cut a release: build, verify, publish, tag.',
  tags: ['release'],
  triggers: ['workflow_dispatch'],
  inputs: [
    { name: 'version', required: true, type: 'string', description: 'semver to publish' },
    { name: 'channel', default: 'stable', options: ['stable', 'next'] },
    { name: 'dryRun', type: 'boolean', default: 'false' },
  ],
  jobs: [
    { name: 'build', steps: ['pnpm build'] },
    { name: 'verify', steps: ['pnpm test'] },
    { name: 'publish', steps: ['pnpm publish -r'] },
  ],
  artifacts: [],
  runners: ['rmux', 'tmux'],
};

const { props } = slotPropsFixture({ sessionId: SESSION_ID });

const meta = {
  title: 'Workflow/LaunchWorkflowDialog',
  component: LaunchWorkflowDialog,
  tags: ['style-system'],
};

export default meta;

/*
 * One dialog only: it is modal and portals into the body, so a second instance
 * would draw its overlay over the first. `version` is required and has no
 * default, which is also what puts the problem line and the disabled submit in
 * the shot.
 */
export const Playground = {
  render: () => (
    <div className="h-screen w-screen bg-doom-bg">
      <LaunchWorkflowDialog
        sessionId={SESSION_ID}
        workflow={RELEASE}
        cwd={CWD}
        initialPrompt="cut 0.4.0 from main"
        send={props.sendSessionFrame}
        onClose={() => undefined}
        onLaunched={() => undefined}
      />
    </div>
  ),
};
