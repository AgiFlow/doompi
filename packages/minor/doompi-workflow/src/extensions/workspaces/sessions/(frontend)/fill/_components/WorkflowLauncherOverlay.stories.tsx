/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture.
 *
 * The sheet is portalled to the page edge, so the frame only has to be tall
 * enough to screenshot it.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';

import type { WorkflowCatalogEntryView } from '../../../../../../types/webWorkflows';
import { catalog } from '../../_lib/catalogStore';
import { WorkflowLauncherOverlay } from './WorkflowLauncherOverlay';

/** Its own session id, so seeding this store cannot disturb another story's. */
const SESSION_ID = 'workflow-launcher';
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
  name: 'release-hardening',
  description: 'Plan, edit, verify and publish a release with evidence.',
  tags: ['release', 'ci'],
  inputs: [{ name: 'version', required: true, type: 'string' }],
  jobs: [
    { name: 'build', steps: ['plan changes', 'edit files', 'typecheck'] },
    { name: 'test', steps: ['unit', 'e2e'] },
  ],
  artifacts: [{ path: 'report.md', kind: 'file', description: 'test and review evidence', producedBy: ['test'] }],
});

catalog.update(SESSION_ID, (current) => ({
  ...current,
  cwd: CWD,
  open: true,
  selected: RELEASE.path,
  workflows: [
    RELEASE,
    entry({ name: 'nightly', description: 'Nightly checks across every package.', tags: ['ci'] }),
    entry({ name: 'docs-refresh', description: 'Regenerate llms.txt and the README tables.', tags: ['docs'] }),
  ],
}));

const meta = {
  title: 'Workflow/WorkflowLauncherOverlay',
  component: WorkflowLauncherOverlay,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="h-[640px] w-full bg-doom-bg p-6">
      <span className="text-2xs uppercase tracking-widest text-doom-dim">catalog opened from SPC w l</span>
      <WorkflowLauncherOverlay {...slotPropsFixture({ sessionId: SESSION_ID }).props} />
    </div>
  ),
};
