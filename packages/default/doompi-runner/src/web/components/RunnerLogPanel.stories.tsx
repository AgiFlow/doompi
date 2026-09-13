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
import { RunnerLogPanel } from './RunnerLogPanel';

/** Its own session id, so a story that seeds this store cannot disturb another's. */
const SESSION_ID = 'runner-log';
const MINUTE_MS = 60_000;

const LOG_LINES = [
  '\u001B[2m$\u001B[0m pnpm vitest run packages/core',
  '',
  '\u001B[32m ✓\u001B[0m src/lib/cn.test.ts (4 tests) 12ms',
  '\u001B[32m ✓\u001B[0m src/lib/hashlineView.test.ts (11 tests) 28ms',
  '\u001B[33m ↓\u001B[0m src/lib/ansi.test.ts (1 skipped)',
  '',
  ' Test Files  2 passed | 1 skipped (3)',
  '      Tests  15 passed | 1 skipped (16)',
  '   Duration  1.42s',
];

const run = (overrides: Partial<RunnerRunView> & Pick<RunnerRunView, 'id' | 'name'>): RunnerRunView => ({
  pid: 4242,
  command: 'pnpm vitest run packages/core',
  cwd: '/Users/doom/workspace/doompi',
  interactive: false,
  backend: 'rmux',
  state: 'running',
  promoted: true,
  startedAt: new Date(Date.now() - 6 * MINUTE_MS).toISOString(),
  logPath: `/tmp/doom/runners/${overrides.id}.log`,
  ...overrides,
});

runners.update(SESSION_ID, () => ({
  runs: [
    run({ id: 'live', name: 'vitest watch' }),
    run({
      id: 'done',
      name: 'docs build',
      command: 'pnpm nx build @agimon-ai/doompi-docs',
      state: 'completed',
      exit: { reason: 'completed', code: 0, signal: null, finishedAt: new Date().toISOString() },
    }),
  ],
  stopRequested: [],
}));

/*
 * The panel reads its lines from the hub over HTTP, and a story has no hub, so
 * the log route is answered here and everything else still reaches the real
 * fetch. Without it every variant would be the "unreachable" banner. The
 * follow stream is left unanswered: it fails, the panel stops following, and
 * the shot is the settled state rather than a race.
 */
const LOG_URL = /\/api\/plugin\/runner\/runners\/([^/?]+)\/log\?/u;
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const runId = LOG_URL.exec(url)?.[1];
  if (runId === undefined) return realFetch(input, init);
  return Promise.resolve(
    Response.json({
      runId,
      running: runId === 'live',
      text: LOG_LINES.join('\n'),
      lineCount: LOG_LINES.length,
      totalLines: 1284,
      fileSize: 48_212,
      completeBytes: 48_212,
      path: `/tmp/doom/runners/${runId}.log`,
      exists: true,
    }),
  );
};

const props = slotPropsFixture({ sessionId: SESSION_ID }).props;

const meta = {
  title: 'Runner/RunnerLogPanel',
  component: RunnerLogPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">a runner that is still writing</span>
        <div className="flex h-96 flex-col rounded-md border border-doom-border bg-doom-bg">
          <RunnerLogPanel {...props} runId="live" />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">a finished runner</span>
        <div className="flex h-96 flex-col rounded-md border border-doom-border bg-doom-bg">
          <RunnerLogPanel {...props} runId="done" />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no longer listed, log still readable</span>
        <div className="flex h-80 flex-col rounded-md border border-doom-border bg-doom-bg">
          <RunnerLogPanel {...props} runId="forgotten" />
        </div>
      </div>
    </div>
  ),
};
