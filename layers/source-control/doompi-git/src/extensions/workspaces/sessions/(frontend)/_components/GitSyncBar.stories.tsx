/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. Every state is a prop, exactly as the channel hands it over.
 */
import type { GitChangesView } from '../../../../../types/gitReview';
import { GitSyncBar, type GitSyncBarProps } from './GitSyncBar';

const CHANGES: GitChangesView = {
  branch: 'feat/git',
  base: 'origin/main',
  added: 120,
  removed: 34,
  files: 6,
  upstream: { ref: 'origin/feat/git', ahead: 2, behind: 1 },
};

const noop = (): void => undefined;
const handlers = { onSync: noop, onForcePush: noop, onAskAgent: noop, onDismissError: noop };

const STATES: { label: string; props: GitSyncBarProps }[] = [
  { label: 'ready · ahead and behind its upstream', props: { changes: CHANGES, mergeBase: '4f2a91c', ...handlers } },
  {
    label: 'new branch · no upstream yet',
    props: { changes: { ...CHANGES, upstream: undefined }, mergeBase: '4f2a91c', ...handlers },
  },
  { label: 'pushing', props: { changes: CHANGES, pending: 'pushing…', ...handlers } },
  {
    label: 'push rejected · asks before a lease force',
    props: {
      changes: CHANGES,
      error: 'The remote rejected the push.',
      errorTarget: { action: 'push', forceRequired: true },
      ...handlers,
    },
  },
  {
    label: 'auth failed',
    props: {
      changes: CHANGES,
      error: 'GitHub refused the token for github.com. Check Settings > git.',
      errorTarget: { action: 'pull' },
      ...handlers,
    },
  },
  {
    label: 'rebase paused on conflicts',
    props: {
      changes: {
        ...CHANGES,
        branch: undefined,
        rebase: { conflicts: ['src/services/gitCli/index.ts', 'src/types/webWorktrees.ts'] },
      },
      ...handlers,
    },
  },
];

const meta = {
  title: 'Git/GitSyncBar',
  component: GitSyncBar,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      {STATES.map((state) => (
        <div key={state.label} className="flex w-[880px] flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">{state.label}</span>
          <div className="rounded-md border border-doom-border-soft bg-doom-rail">
            <GitSyncBar {...state.props} />
          </div>
        </div>
      ))}
    </div>
  ),
};
