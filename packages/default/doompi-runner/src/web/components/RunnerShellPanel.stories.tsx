/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the slot contract breaks this
 * story at the type level instead of silently drifting.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { RunnerRunView } from '../../types/webRunners';
import { runners } from '../stores/runnersStore';
import { RunnerShellPanel } from './RunnerShellPanel';

/** Its own session id, so a story that seeds this store cannot disturb another's. */
const SESSION_ID = 'runner-shell';

const run = (overrides: Partial<RunnerRunView> & Pick<RunnerRunView, 'id' | 'name'>): RunnerRunView => ({
  pid: 4242,
  command: 'zsh -l',
  cwd: '/Users/doom/workspace/doompi',
  interactive: true,
  backend: 'rmux',
  state: 'running',
  promoted: true,
  startedAt: new Date().toISOString(),
  logPath: `/tmp/doom/runners/${overrides.id}.log`,
  ...overrides,
});

runners.update(SESSION_ID, () => ({
  runs: [
    run({ id: 'attached', name: 'dev shell' }),
    run({
      id: 'detached',
      name: 'old shell',
      state: 'completed',
      exit: { reason: 'completed', code: 0, signal: null, finishedAt: new Date().toISOString() },
    }),
  ],
  stopRequested: [],
}));

const props = slotPropsFixture({ sessionId: SESSION_ID }).props;

const meta = {
  title: 'Runner/RunnerShellPanel',
  component: RunnerShellPanel,
  tags: ['style-system'],
};

export default meta;

/*
 * The pane itself stays empty: its bytes arrive on a server-sent stream and a
 * story has no hub to open one against. What is reviewable here is the chrome
 * around the emulator, and that the emulator mounts at all, since xterm is
 * imported only when this panel opens.
 */
export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">attached</span>
        <div className="flex h-64 flex-col rounded-md border border-doom-border bg-doom-bg">
          <RunnerShellPanel {...props} runId="attached" />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">the runner has exited</span>
        <div className="flex h-64 flex-col rounded-md border border-doom-border bg-doom-bg">
          <RunnerShellPanel {...props} runId="detached" />
        </div>
      </div>
    </div>
  ),
};
