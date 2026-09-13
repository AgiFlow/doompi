/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the slot contract breaks this
 * story at the type level instead of silently drifting.
 */
import type { WorkflowCatalogEntryView } from '../../types/webWorkflows';
import { catalog } from '../stores/catalogStore';
import { WorkflowCatalogDrawer } from './WorkflowCatalogDrawer';

/** Its own session id, so a story that seeds this store cannot disturb another's. */
const SESSION_ID = 'workflow-catalog';
const EMPTY_SESSION_ID = 'workflow-catalog-empty';
const CWD = '/Users/doom/workspace/doompi';

const entry = (
  overrides: Partial<WorkflowCatalogEntryView> & Pick<WorkflowCatalogEntryView, 'name'>,
): WorkflowCatalogEntryView => ({
  path: `${CWD}/automations/workflows/${overrides.name}.workflow.yaml`,
  relativePath: `automations/workflows/${overrides.name}.workflow.yaml`,
  description: '',
  tags: [],
  triggers: ['workflow_dispatch'],
  inputs: [],
  jobs: [],
  artifacts: [],
  ...overrides,
});

const RELEASE = entry({
  name: 'release',
  description: 'Cut a release: build, verify, publish, tag.',
  tags: ['release', 'ci'],
  inputs: [
    { name: 'version', required: true, type: 'string' },
    { name: 'channel', default: 'stable', options: ['stable', 'next'] },
  ],
  jobs: [
    { name: 'build', steps: ['pnpm install', 'pnpm build'] },
    { name: 'verify', steps: ['pnpm test'] },
    { name: 'publish', steps: ['pnpm publish -r'] },
  ],
  artifacts: [{ path: 'dist/report.json', kind: 'file', description: 'the release report', producedBy: ['verify'] }],
  runners: ['rmux'],
});

// The drawer renders whatever the catalog channel last reported, so the story
// seeds the same store that channel writes into.
catalog.update(SESSION_ID, (current) => ({
  ...current,
  cwd: CWD,
  open: true,
  selected: RELEASE.path,
  inspected: RELEASE.path,
  workflows: [
    RELEASE,
    entry({
      name: 'nightly',
      description: 'Nightly checks across every package.',
      tags: ['ci'],
      jobs: [{ name: 'check', steps: ['pnpm lint'] }],
    }),
    entry({ name: 'hotfix', tags: ['release'], error: 'jobs: expected a mapping at line 12' }),
  ],
}));

catalog.update(EMPTY_SESSION_ID, (current) => ({
  ...current,
  cwd: CWD,
  open: true,
  warning: 'automations/workflows is not readable from this session',
}));

const meta = {
  title: 'Workflow/WorkflowCatalogDrawer',
  component: WorkflowCatalogDrawer,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          three workflows · the selected row is unfolded
        </span>
        <div className="flex h-screen rounded-md border border-doom-border">
          <WorkflowCatalogDrawer sessionId={SESSION_ID} onClose={() => undefined} onLaunch={() => undefined} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">nothing to list</span>
        <div className="flex h-64 rounded-md border border-doom-border">
          <WorkflowCatalogDrawer sessionId={EMPTY_SESSION_ID} onClose={() => undefined} onLaunch={() => undefined} />
        </div>
      </div>
    </div>
  ),
};
