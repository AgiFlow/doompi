/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the slot contract breaks this
 * story at the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { WorkflowToolMessage } from './WorkflowToolMessage';

/** The tools answer in JSON text blocks, so the fixtures are the payloads themselves. */
const json = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], details: null });
const text = (value: string) => ({ content: [{ type: 'text', text: value }], details: null });

const CATALOG = {
  directory: '.doom/workflows',
  page: 1,
  pageSize: 10,
  total: 3,
  totalPages: 1,
  tags: [
    { tag: 'release', count: 2 },
    { tag: 'ci', count: 1 },
  ],
  workflows: [
    { name: 'release', path: '.doom/workflows/release.workflow.yaml', description: 'Cut a release', tags: ['release'] },
    { name: 'nightly', path: '.doom/workflows/nightly.workflow.yaml', description: 'Nightly checks', tags: ['ci'] },
    { name: 'hotfix', path: '.doom/workflows/hotfix.workflow.yaml', description: '', tags: ['release'] },
  ],
};

const STATUS = {
  runKey: 'release-2025-01-14',
  workspace: 'doompi',
  displayName: 'release',
  stage: 'running',
  runner: 'rmux',
  startedAt: '2025-01-14T09:12:00.000Z',
  executionCursor: { job: 'build', phase: 'job', stepName: 'pnpm build' },
};

const FAILED = {
  runKey: 'release-2025-01-13',
  workspace: 'doompi',
  displayName: 'release',
  stage: 'error',
  outcome: 'failed',
  errorMessage: 'job build exited 1',
  exitCode: 1,
  startedAt: '2025-01-13T21:40:00.000Z',
};

const LAUNCHED = [
  'Started release in workspace doompi.',
  'Run key: release-2025-01-14',
  'Next steps for the agent: poll workflow_run status.',
].join('\n');

const props = (overrides: Parameters<typeof toolMessagePropsFixture>[0]) => toolMessagePropsFixture(overrides).props;

const meta = {
  title: 'Workflow/WorkflowToolMessage',
  component: WorkflowToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">list_workflows · the catalog</span>
        <WorkflowToolMessage
          {...props({
            toolName: 'list_workflows',
            args: { directory: '.doom/workflows', page: 1, pageSize: 10 },
            result: json(CATALOG),
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">launch_workflow · accepted</span>
        <WorkflowToolMessage
          {...props({
            toolName: 'launch_workflow',
            args: { workflowPath: '.doom/workflows/release.workflow.yaml', workspace: 'doompi', runner: 'rmux' },
            result: text(LAUNCHED),
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">workflow_run · running</span>
        <WorkflowToolMessage
          {...props({
            toolName: 'workflow_run',
            args: { action: 'status', workspace: 'doompi', runKey: 'release-2025-01-14' },
            result: json(STATUS),
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">workflow_run · a stop asked for</span>
        <WorkflowToolMessage
          {...props({
            toolName: 'workflow_run',
            args: { action: 'stop', workspace: 'doompi', runKey: 'release-2025-01-14', reason: 'superseded' },
            result: json({ runKey: 'release-2025-01-14', requestedAt: '2025-01-14T09:14:20.000Z' }),
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">workflow_run · a failed run</span>
        <WorkflowToolMessage
          {...props({
            toolName: 'workflow_run',
            args: { action: 'status', workspace: 'doompi', runKey: 'release-2025-01-13' },
            result: json(FAILED),
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running, then failed</span>
        <WorkflowToolMessage
          {...props({
            toolName: 'launch_workflow',
            args: { workflowPath: '.doom/workflows/release.workflow.yaml' },
            result: text('Resolving workflow…\nValidating inputs…'),
            running: true,
          })}
        />
        <WorkflowToolMessage
          {...props({
            toolName: 'launch_workflow',
            args: { workflowPath: '.doom/workflows/missing.workflow.yaml' },
            result: text('Workflow file not found.\nChecked .doom/workflows.'),
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
