/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`. The slot props come from the contracts
 * package's own testing fixture, and the rows come from the real session store
 * seeded at module scope, which is the only input this component reads.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { SubagentRun } from '../../types/webSubagents.ts';
import { subagents } from '../stores/subagentsStore.ts';
import { AgentsActivitySection } from './AgentsActivitySection.tsx';

const NOW = Date.now();
const MINUTE = 60_000;

const run = (overrides: Partial<SubagentRun> & Pick<SubagentRun, 'runId' | 'agent' | 'state'>): SubagentRun => ({
  rawState: overrides.state,
  task: 'review the team stories',
  cwd: '/Users/dev/workspace/doompi',
  startedAt: NOW - 4 * MINUTE,
  lastUpdate: NOW,
  tail: [],
  ...overrides,
});

/** activityRuns() keeps only queued and running rows, so the done one below is filtered out. */
subagents.update('agents-busy', (current) => ({
  ...current,
  runs: [
    run({
      runId: 'run-8f21',
      agent: 'reviewer',
      state: 'running',
      startedAt: NOW - 7 * MINUTE,
      currentTool: 'read · packages/core/doompi-web-contracts',
      toolCount: 24,
    }),
    run({
      runId: 'run-8f22',
      agent: 'tester',
      state: 'running',
      startedAt: NOW - 2 * MINUTE,
      toolCount: 6,
      tail: ['pnpm exec vitest run src/web'],
    }),
    run({ runId: 'run-8f23', agent: 'scout', state: 'queued', startedAt: NOW, toolCount: 0 }),
    run({ runId: 'run-8f14', agent: 'reviewer', state: 'done', summary: 'two defects filed' }),
  ],
}));

const meta = {
  title: 'Team/AgentsActivitySection',
  component: AgentsActivitySection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex max-w-lg flex-col gap-6 bg-doom-bg p-6">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no runs</span>
        <div className="rounded-md border border-doom-border-soft bg-doom-panel p-2">
          <AgentsActivitySection {...slotPropsFixture({ sessionId: 'agents-idle' }).props} />
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running, queued, and one filtered out</span>
        <div className="rounded-md border border-doom-border-soft bg-doom-panel p-2">
          <AgentsActivitySection {...slotPropsFixture({ sessionId: 'agents-busy' }).props} />
        </div>
      </div>
    </div>
  ),
};
