/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`. The slot props come from the contracts
 * package's own testing fixture, whose `thread` option stands in for the host's
 * transcript; the runs come from the real session store seeded at module scope.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';
import type { ReactNode } from 'react';

import type { SubagentRun } from '../../types/webSubagents';
import { subagents } from '../stores/subagentsStore';
import { AgentThreadPanel } from './AgentThreadPanel';

const NOW = Date.now();
const MINUTE = 60_000;

const run = (overrides: Partial<SubagentRun> & Pick<SubagentRun, 'runId' | 'agent' | 'state'>): SubagentRun => ({
  rawState: overrides.state,
  task: 'review the team stories\nand file anything that will not mount',
  cwd: '/Users/dev/workspace/doompi',
  startedAt: NOW - 7 * MINUTE,
  lastUpdate: NOW,
  tail: [],
  ...overrides,
});

subagents.update('thread-live', (current) => ({
  ...current,
  runs: [run({ runId: 'run-8f21', agent: 'reviewer', state: 'running', model: 'anthropic/claude-sonnet-4-5' })],
}));

subagents.update('thread-stopping', (current) => ({
  ...current,
  runs: [run({ runId: 'run-8f22', agent: 'tester', state: 'running' })],
  stopRequested: ['run-8f22'],
}));

subagents.update('thread-done', (current) => ({
  ...current,
  runs: [
    run({
      runId: 'run-8f14',
      agent: 'reviewer',
      state: 'done',
      endedAt: NOW - MINUTE,
      summary: 'two defects filed',
    }),
  ],
}));

/** Stands in for the host transcript the cockpit renders into this panel. */
const thread = (threadId: string): ReactNode => (
  <div className="min-h-0 flex-1 overflow-auto px-6 py-4 text-xs text-doom-dim">
    <p className="text-doom-faint">transcript of {threadId}</p>
    <p className="pt-2 text-doom-text">read packages/core/doompi-core/src/services/testing/slotProps.ts</p>
    <p className="pt-1 text-doom-text">the fixture already builds every slot prop, so the story stays honest</p>
  </div>
);

const Framed = ({ caption, children }: { caption: string; children: ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-2">
    <span className="text-2xs text-doom-dim uppercase tracking-widest">{caption}</span>
    <div className="flex h-72 flex-col overflow-hidden rounded-md border border-doom-border-soft bg-doom-bg">
      {children}
    </div>
  </div>
);

const meta = {
  title: 'Team/AgentThreadPanel',
  component: AgentThreadPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <Framed caption="running · stop and steer">
        <AgentThreadPanel {...slotPropsFixture({ sessionId: 'thread-live', thread }).props} runId="run-8f21" />
      </Framed>

      <Framed caption="stop requested">
        <AgentThreadPanel {...slotPropsFixture({ sessionId: 'thread-stopping', thread }).props} runId="run-8f22" />
      </Framed>

      <Framed caption="finished · no composer">
        <AgentThreadPanel {...slotPropsFixture({ sessionId: 'thread-done', thread }).props} runId="run-8f14" />
      </Framed>

      <Framed caption="run no longer listed">
        <AgentThreadPanel {...slotPropsFixture({ sessionId: 'thread-gone', thread }).props} runId="run-8f09xyz" />
      </Framed>
    </div>
  ),
};
