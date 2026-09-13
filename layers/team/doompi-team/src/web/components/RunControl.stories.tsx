/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`. The frame sender comes from the
 * contracts package's own testing fixture rather than a hand-rolled stub.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';

import type { SubagentRun } from '../../types/webSubagents';
import { elapsedRun, RunControl } from './RunControl';

const NOW = Date.now();
const MINUTE = 60_000;
const send = slotPropsFixture({ sessionId: 'runs' }).props.sendSessionFrame;

const run = (overrides: Partial<SubagentRun> & Pick<SubagentRun, 'runId' | 'agent' | 'state'>): SubagentRun => ({
  rawState: overrides.state,
  task: 'review the team stories',
  cwd: '/Users/dev/workspace/doompi',
  startedAt: NOW - 4 * MINUTE,
  lastUpdate: NOW,
  tail: [],
  ...overrides,
});

const ROWS: readonly { caption: string; run: SubagentRun; stopping: boolean }[] = [
  { caption: 'running', run: run({ runId: 'run-01', agent: 'reviewer', state: 'running' }), stopping: false },
  {
    caption: 'queued',
    run: run({ runId: 'run-02', agent: 'scout', state: 'queued', startedAt: NOW }),
    stopping: false,
  },
  { caption: 'stop requested', run: run({ runId: 'run-03', agent: 'tester', state: 'running' }), stopping: true },
  {
    caption: 'done',
    run: run({ runId: 'run-04', agent: 'reviewer', state: 'done', endedAt: NOW - MINUTE }),
    stopping: false,
  },
  {
    caption: 'failed',
    run: run({ runId: 'run-05', agent: 'tester', state: 'failed', endedAt: NOW - 2 * MINUTE }),
    stopping: false,
  },
  {
    caption: 'stopped',
    run: run({ runId: 'run-06', agent: 'scout', state: 'stopped', endedAt: NOW - 30_000 }),
    stopping: false,
  },
];

const meta = {
  title: 'Team/RunControl',
  component: RunControl,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex max-w-md flex-col gap-3 bg-doom-bg p-6">
      {ROWS.map((row) => (
        <div
          key={row.run.runId}
          className="flex items-center gap-3 rounded-md border border-doom-border-soft bg-doom-panel px-3 py-2"
        >
          <span className="w-32 shrink-0 text-2xs text-doom-dim uppercase tracking-widest">{row.caption}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-doom-faint">{elapsedRun(row.run, NOW)}</span>
          <RunControl sessionId="runs" run={row.run} stopping={row.stopping} send={send} />
        </div>
      ))}
    </div>
  ),
};
