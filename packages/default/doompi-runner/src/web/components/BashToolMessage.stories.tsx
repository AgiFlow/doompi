/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the slot contract breaks this
 * story at the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { RunnerRunView } from '../../types/webRunners';
import { runners } from '../stores/runnersStore';
import { BashToolMessage } from './BashToolMessage';

const SESSION_ID = 's1';

const run = (overrides: Partial<RunnerRunView> & Pick<RunnerRunView, 'id'>): RunnerRunView => ({
  name: overrides.id,
  pid: 4242,
  command: 'pnpm test',
  cwd: '/Users/doom/workspace/doompi',
  interactive: false,
  backend: 'rmux',
  state: 'running',
  promoted: false,
  startedAt: '2025-01-14T09:12:00.000Z',
  logPath: `/tmp/doom/runners/${overrides.id}.log`,
  ...overrides,
});

// The header's log and stop controls only appear for a run the runners channel
// has reported, so the story seeds the same store that channel writes into.
runners.update(SESSION_ID, () => ({
  runs: [
    run({
      id: 'run-1',
      state: 'completed',
      exit: { reason: 'completed', code: 0, signal: null, finishedAt: '2025-01-14T09:12:31.000Z' },
    }),
    run({ id: 'bg-2', name: 'vitest watch', promoted: true, command: 'pnpm vitest --watch' }),
    run({ id: 'bg-3', name: 'dev server', promoted: true, command: 'pnpm dev' }),
  ],
  stopRequested: ['bg-3'],
}));

const TAIL = [
  '$ pnpm test',
  '',
  ' ✓ src/lib/cn.test.ts (4 tests) 12ms',
  ' ✓ src/lib/theme.test.ts (9 tests) 31ms',
  '',
  ' Test Files  2 passed (2)',
  '      Tests  13 passed (13)',
].join('\n');

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'bash', ...overrides }).props;

/*
 * The card is collapsed until someone clicks it and the renderer only takes a
 * screenshot, so every result body here would be invisible. Opening the card
 * from a mount ref is what puts the body in the shot; the collapsed header is
 * shown once on its own so both states are reviewable.
 */
const openCard = (node: HTMLDivElement | null) =>
  node?.querySelector<HTMLButtonElement>('[data-testid="tool-expand"]')?.click();

const meta = {
  title: 'Runner/BashToolMessage',
  component: BashToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">collapsed · the default</span>
        <BashToolMessage
          {...props({
            args: { command: 'pnpm test', timeout: 120 },
            result: { content: [], details: { id: 'run-1', tail: TAIL, exitCode: 0 } },
          })}
        />
      </div>

      <div className="flex flex-col gap-2" ref={openCard}>
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <BashToolMessage {...props({ args: { command: 'pnpm test' }, output: TAIL, running: true })} />
      </div>

      <div className="flex flex-col gap-2" ref={openCard}>
        <span className="text-2xs text-doom-dim uppercase tracking-widest">expanded · finished, with its log</span>
        <BashToolMessage
          {...props({
            args: { command: 'pnpm test', timeout: 120 },
            result: {
              content: [],
              details: {
                id: 'run-1',
                runner: 'rmux',
                exitCode: 0,
                lines: 13,
                fileSize: 2048,
                logPath: '/tmp/doom/runners/run-1.log',
                tail: TAIL,
              },
            },
          })}
        />
      </div>

      <div className="flex flex-col gap-2" ref={openCard}>
        <span className="text-2xs text-doom-dim uppercase tracking-widest">expanded · promoted to the background</span>
        <BashToolMessage
          {...props({
            args: { command: 'pnpm vitest --watch', background: true, name: 'vitest watch' },
            result: { content: [], details: { id: 'bg-2', runner: 'vitest watch', promoted: true } },
          })}
        />
      </div>

      <div className="flex flex-col gap-2" ref={openCard}>
        <span className="text-2xs text-doom-dim uppercase tracking-widest">expanded · a stop already asked for</span>
        <BashToolMessage
          {...props({
            args: { command: 'pnpm dev', background: true, interactive: true, name: 'dev server' },
            result: { content: [], details: { id: 'bg-3', runner: 'dev server', promoted: true } },
          })}
        />
      </div>

      <div className="flex flex-col gap-2" ref={openCard}>
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <BashToolMessage
          {...props({
            args: { command: 'pnpm build' },
            result: { content: [{ type: 'text', text: 'error TS2345: argument of type string' }], details: null },
            output: 'error TS2345: argument of type string',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
