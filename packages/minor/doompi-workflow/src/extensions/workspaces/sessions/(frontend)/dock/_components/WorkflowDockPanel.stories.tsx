/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition.
 *
 * The live panel reads its artifacts from the workflow API, which a story has
 * no backend for, so the variants render the panel's view with a fixed
 * listing. The empty frame renders the live panel itself, which needs no API.
 */
import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';
import type { ReactNode } from 'react';

import type { WorkflowJobView, WorkflowRunView } from '../../../../../../types/webWorkflows';
import type { WorkflowArtifactsResponse } from '../../../../../../types/webWorkflowTerminal';
import { ArtifactList } from '../../_components/ArtifactsPane';
import { WorkflowDockPanel, WorkflowDockView } from './WorkflowDockPanel';

bindSessionApiWorkspace(() => 'stories');

const SESSION_ID = 'workflow-dock';
const MINUTE_MS = 60_000;
/** One clock for every frame, read once, so durations agree across the story. */
const NOW = Date.now();
const ago = (minutes: number): string => new Date(NOW - minutes * MINUTE_MS).toISOString();
const noop = (): void => undefined;

const run = (
  overrides: Partial<WorkflowRunView> & Pick<WorkflowRunView, 'runKey' | 'displayName'>,
): WorkflowRunView => ({
  workspace: 'doompi',
  workflowPath: '.doom/workflows/release-hardening.workflow.yaml',
  stage: 'running',
  startedAt: ago(4),
  ownerSessionId: SESSION_ID,
  jobs: [],
  ...overrides,
});

const setup: WorkflowJobView = {
  name: 'setup',
  phase: 'pre',
  status: 'completed',
  startedAt: ago(4),
  endedAt: ago(3.8),
  steps: [{ name: 'install', status: 'completed', startedAt: ago(4), endedAt: ago(3.8) }],
};

const buildRunning: WorkflowJobView = {
  name: 'build',
  phase: 'job',
  status: 'running',
  startedAt: ago(3.8),
  steps: [
    { name: 'plan changes', status: 'completed', startedAt: ago(3.8), endedAt: ago(2.9) },
    {
      name: 'edit token.ts',
      status: 'running',
      group: 'edits',
      ref: { kind: 'session', id: 'step-1' },
      startedAt: ago(1.2),
    },
    {
      name: 'edit session.ts',
      status: 'running',
      group: 'edits',
      ref: { kind: 'session', id: 'step-2' },
      startedAt: ago(1.1),
    },
    { name: 'typecheck', status: 'running', ref: { kind: 'pane', id: 'pane-1' }, startedAt: ago(0.4) },
  ],
};

const skipped: WorkflowJobView = {
  name: 'release',
  phase: 'job',
  status: 'skipped',
  reason: 'runs only on main',
  steps: [],
};

const listing = (running: boolean): WorkflowArtifactsResponse => ({
  runDir: '/Users/dev/.workflow-mcp/workspaces/doompi/running/release-hardening-14',
  description: 'release notes and evidence',
  artifacts: [
    {
      path: 'plan.md',
      kind: 'file',
      description: 'what the run intends to change',
      producedBy: ['build'],
      declared: true,
      state: 'written',
      size: 2_340,
      modifiedAt: ago(3),
    },
    {
      path: 'report.md',
      kind: 'file',
      description: 'test and review evidence',
      producedBy: ['test'],
      declared: true,
      state: running ? 'pending' : 'written',
      ...(running ? {} : { size: 8_912, modifiedAt: ago(1) }),
    },
    {
      path: 'coverage',
      kind: 'directory',
      description: 'coverage output',
      producedBy: ['test'],
      declared: true,
      state: running ? 'pending' : 'written',
    },
    {
      path: 'scratch/notes.txt',
      kind: 'file',
      description: '',
      producedBy: [],
      declared: false,
      state: 'written',
      size: 412,
      modifiedAt: ago(2),
    },
  ],
});

const running = run({
  runKey: 'release-hardening-14',
  displayName: 'release-hardening',
  position: { job: 'build', step: 'edit token.ts', index: 2, total: 4 },
  jobs: [setup, buildRunning],
});

const earlier = run({
  runKey: 'release-hardening-13',
  displayName: 'release-hardening (retry)',
  stage: 'completed',
  outcome: 'success',
  startedAt: ago(40),
  finishedAt: ago(28),
});

const failed = run({
  runKey: 'nightly-9',
  displayName: 'nightly',
  stage: 'error',
  outcome: 'failed',
  failedJob: 'test',
  errorMessage: "step 'e2e' exited 1: 3 specs failed in workflows.spec.ts",
  startedAt: ago(22),
  finishedAt: ago(6),
  jobs: [
    { ...setup, startedAt: ago(22), endedAt: ago(21) },
    {
      name: 'build',
      phase: 'job',
      status: 'completed',
      startedAt: ago(21),
      endedAt: ago(12),
      steps: [{ name: 'compile', status: 'completed', startedAt: ago(21), endedAt: ago(12) }],
    },
    {
      name: 'test',
      phase: 'job',
      status: 'failed',
      startedAt: ago(12),
      endedAt: ago(6),
      steps: [
        { name: 'unit', status: 'completed', startedAt: ago(12), endedAt: ago(9) },
        {
          name: 'e2e',
          status: 'failed',
          reason: '3 specs failed in workflows.spec.ts',
          ref: { kind: 'pane', id: 'pane-2' },
          startedAt: ago(9),
          endedAt: ago(6),
        },
      ],
    },
  ],
});

const paused = run({
  runKey: 'migration-3',
  displayName: 'schema-migration',
  executionState: 'paused',
  startedAt: ago(15),
  position: { job: 'migrate', step: 'review plan' },
  jobs: [
    {
      name: 'migrate',
      phase: 'job',
      status: 'paused',
      startedAt: ago(14),
      steps: [
        { name: 'draft plan', status: 'completed', startedAt: ago(14), endedAt: ago(10) },
        { name: 'review plan', status: 'paused', ref: { kind: 'session', id: 'step-3' }, startedAt: ago(10) },
      ],
    },
  ],
});

const succeeded = run({
  runKey: 'hotfix-12',
  displayName: 'hotfix',
  stage: 'completed',
  outcome: 'success',
  startedAt: ago(30),
  finishedAt: ago(18),
  jobs: [
    { ...setup, startedAt: ago(30), endedAt: ago(29) },
    {
      name: 'build',
      phase: 'job',
      status: 'completed',
      startedAt: ago(29),
      endedAt: ago(22),
      steps: [{ name: 'patch', status: 'completed', startedAt: ago(29), endedAt: ago(22) }],
    },
    {
      name: 'test',
      phase: 'job',
      status: 'completed',
      startedAt: ago(22),
      endedAt: ago(18),
      steps: [{ name: 'unit', status: 'completed', startedAt: ago(22), endedAt: ago(18) }],
    },
    skipped,
  ],
});

const starting = run({ runKey: 'docs-2', displayName: 'docs-refresh', startedAt: ago(0.2) });

function DockFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-2xs uppercase tracking-widest text-doom-dim">{label}</span>
      <div className="flex h-[640px] w-[300px] flex-col overflow-hidden border-l border-doom-border bg-doom-rail">
        <div className="flex h-11 shrink-0 items-center gap-3 border-b border-doom-border px-4">
          <span className="text-2xs font-bold tracking-widest text-doom-faint">ACTIVITY</span>
          <span className="text-2xs font-bold tracking-widest text-doom-faint">CONTEXT</span>
          <span className="text-2xs font-bold tracking-widest text-doom-hi">WORKFLOW</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function View({ runs, artifacts }: { runs: WorkflowRunView[]; artifacts?: WorkflowArtifactsResponse }) {
  return (
    <WorkflowDockView
      runs={runs}
      run={runs[0]!}
      now={NOW}
      sessionId={SESSION_ID}
      onSelectRun={noop}
      onOpenStep={noop}
      onDeleted={noop}
      artifacts={<ArtifactList listing={artifacts} error={undefined} onOpen={noop} />}
    />
  );
}

const meta = {
  title: 'Workflow/WorkflowDockPanel',
  component: WorkflowDockView,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-wrap gap-8 bg-doom-bg p-6">
      <DockFrame label="running · parallel steps · two runs">
        <View runs={[running, earlier]} artifacts={listing(true)} />
      </DockFrame>
      <DockFrame label="failed">
        <View runs={[failed]} artifacts={listing(true)} />
      </DockFrame>
      <DockFrame label="paused">
        <View runs={[paused]} artifacts={{ ...listing(true), artifacts: [] }} />
      </DockFrame>
      <DockFrame label="succeeded">
        <View runs={[succeeded]} artifacts={listing(false)} />
      </DockFrame>
      <DockFrame label="starting">
        <View runs={[starting]} />
      </DockFrame>
      <DockFrame label="no run in this session">
        <WorkflowDockPanel {...slotPropsFixture({ sessionId: 'workflow-dock-empty' }).props} />
      </DockFrame>
    </div>
  ),
};
