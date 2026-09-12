/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`. The slot props come from the contracts
 * package's own testing fixture, whose `thread` option stands in for the host's
 * transcript; the fleet comes from the real session store seeded at module scope.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';
import type { ReactNode } from 'react';
import type { SubagentRun } from '../../types/webSubagents';
import { subagents } from '../stores/subagentsStore';
import { SubagentsPanel } from './SubagentsPanel';

const NOW = Date.now();
const MINUTE = 60_000;

const run = (overrides: Partial<SubagentRun> & Pick<SubagentRun, 'runId' | 'agent' | 'state'>): SubagentRun => ({
  rawState: overrides.state,
  task: 'review the team stories batch and report anything that will not mount',
  cwd: '/Users/dev/workspace/doompi/layers/team/doompi-team',
  startedAt: NOW - 6 * MINUTE,
  lastUpdate: NOW,
  tail: [],
  ...overrides,
});

subagents.update('fleet-busy', (current) => ({
  ...current,
  stopRequested: ['run-8f22'],
  runs: [
    run({
      runId: 'run-8f21',
      agent: 'reviewer',
      state: 'running',
      taskRef: '6',
      model: 'anthropic/claude-sonnet-4-5',
      toolCount: 24,
      tokens: 184_213,
    }),
    run({
      runId: 'run-8f22',
      agent: 'tester',
      state: 'running',
      startedAt: NOW - 2 * MINUTE,
      toolCount: 6,
      tokens: 41_902,
      task: 'run the affected suites for the file-edit stories',
    }),
    run({
      runId: 'run-8f14',
      agent: 'reviewer',
      state: 'done',
      endedAt: NOW - MINUTE,
      toolCount: 31,
      tokens: 210_770,
      summary: 'two defects filed; the rest of the batch mounts',
    }),
    run({
      runId: 'run-8f02',
      agent: 'tester',
      state: 'failed',
      endedAt: NOW - 3 * MINUTE,
      toolCount: 9,
      error: 'typecheck did not pass: src/web/components/RunControl.stories.tsx(12,7)',
    }),
  ],
}));

/** Stands in for the host transcript the cockpit renders into each card. */
const thread = (threadId: string): ReactNode => (
  <div className="flex flex-col gap-1 px-3 py-2 text-2xs text-doom-dim">
    <span className="text-doom-faint">{threadId}</span>
    <span className="text-doom-text">read src/web/components/SubagentsPanel.tsx</span>
    <span className="text-doom-text">grep slotPropsFixture packages/core/doompi-core</span>
    <span className="text-doom-text">bash pnpm exec oxlint src/web/components</span>
  </div>
);

const meta = {
  title: 'Team/SubagentsPanel',
  component: SubagentsPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex w-screen flex-col gap-6 bg-doom-bg p-6">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">a fleet, one stop requested</span>
        <div className="flex h-screen overflow-hidden rounded-md border border-doom-border-soft">
          <SubagentsPanel {...slotPropsFixture({ sessionId: 'fleet-busy', thread }).props} />
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">nothing launched yet</span>
        <div className="flex h-96 overflow-hidden rounded-md border border-doom-border-soft">
          <SubagentsPanel {...slotPropsFixture({ sessionId: 'fleet-empty', thread }).props} />
        </div>
      </div>
    </div>
  ),
};
