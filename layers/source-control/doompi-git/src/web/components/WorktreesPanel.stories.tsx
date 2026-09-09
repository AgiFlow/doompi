/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The slot props come from the contracts package's own testing
 * fixture, and the rows come from the plugin's own session store seeded per
 * session id, which is exactly where the hub channel puts them.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { WorktreeView } from '../../types/webWorktrees.ts';
import { worktreeActivity } from '../stores/worktreesActivityStore.ts';
import { WorktreesPanel } from './WorktreesPanel.tsx';

const WORKTREES: WorktreeView[] = [
  {
    id: 'a1b2c3d4',
    branch: 'wt/fix-auth',
    path: '~/.doom/git/worktrees/fix-auth',
    sessionId: 's7',
    orphaned: false,
    unowned: false,
  },
  {
    id: 'e5f6a7b8',
    branch: 'wt/split-hub',
    path: '~/.doom/git/worktrees/split-hub',
    sessionId: null,
    orphaned: true,
    unowned: false,
  },
  {
    id: 'c9d0e1f2',
    branch: 'wt/retry-queue',
    path: '~/.doom/git/worktrees/retry-queue',
    sessionId: null,
    orphaned: false,
    unowned: true,
  },
];

worktreeActivity.update('panel-live', () => ({ worktrees: WORKTREES, pending: undefined, error: undefined }));
worktreeActivity.update('panel-busy', () => ({
  worktrees: WORKTREES.slice(0, 1),
  pending: 'starting session\u2026',
  error: 'close refused: wt/split-hub has uncommitted changes',
}));

const slot = (sessionId: string | null) => slotPropsFixture({ sessionId }).props;

const meta = {
  title: 'Git/WorktreesPanel',
  component: WorktreesPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">empty</span>
        <WorktreesPanel {...slot('panel-empty')} />
      </div>

      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">three worktrees</span>
        <WorktreesPanel {...slot('panel-live')} />
      </div>

      <div className="flex w-96 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">work in flight · last failure</span>
        <WorktreesPanel {...slot('panel-busy')} />
      </div>
    </div>
  ),
};
