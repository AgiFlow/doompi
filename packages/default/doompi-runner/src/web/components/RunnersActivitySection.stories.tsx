/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the slot contract breaks this
 * story at the type level instead of silently drifting.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';

import type { RunnerRunView } from '../../types/webRunners';
import { runners } from '../stores/runnersStore';
import { RunnersActivitySection } from './RunnersActivitySection';

/** Its own session id, so a story that seeds this store cannot disturb another's. */
const SESSION_ID = 'runners-activity';
const IDLE_SESSION_ID = 'runners-activity-idle';
const MINUTE_MS = 60_000;

const run = (overrides: Partial<RunnerRunView> & Pick<RunnerRunView, 'id' | 'name'>): RunnerRunView => ({
  pid: 4242,
  command: 'pnpm test',
  cwd: '/Users/doom/workspace/doompi',
  interactive: false,
  backend: 'rmux',
  state: 'running',
  promoted: true,
  // Relative, so the uptime the row prints stays a plausible few minutes.
  startedAt: new Date(Date.now() - 3 * MINUTE_MS).toISOString(),
  logPath: `/tmp/doom/runners/${overrides.id}.log`,
  ...overrides,
});

// The dock renders whatever the runners channel last reported, so the story
// seeds the same store that channel writes into.
runners.update(SESSION_ID, () => ({
  runs: [
    run({ id: 'r1', name: 'vitest watch', command: 'pnpm vitest --watch packages/core' }),
    run({
      id: 'r2',
      name: 'dev shell',
      interactive: true,
      command: 'zsh -l',
      startedAt: new Date(Date.now() - 47 * MINUTE_MS).toISOString(),
    }),
    run({ id: 'r3', name: 'docs build', command: 'pnpm nx build @agimon-ai/doompi-docs --verbose' }),
  ],
  stopRequested: ['r3'],
}));

const props = (sessionId: string) => slotPropsFixture({ sessionId }).props;

const meta = {
  title: 'Runner/RunnersActivitySection',
  component: RunnersActivitySection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          three running, one stop asked for · at the dock's width
        </span>
        <div className="w-72 rounded-md border border-doom-border bg-doom-panel p-2">
          <RunnersActivitySection {...props(SESSION_ID)} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">idle</span>
        <div className="w-72 rounded-md border border-doom-border bg-doom-panel p-2">
          <RunnersActivitySection {...props(IDLE_SESSION_ID)} />
        </div>
      </div>
    </div>
  ),
};
