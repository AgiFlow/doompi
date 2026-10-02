/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The slot props come from the contracts package's own testing
 * fixture, and the rows come from the plugin's own session store seeded per
 * session id, which is exactly where the hub channel puts them.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';
import { Kbd } from '@agimon-ai/doompi-web-components';

import type { WorktreeView } from '../../../../../../types/webWorktrees';
import { gitChanges } from '../../_lib/gitChangesStore';
import { worktreeActivity } from '../../_lib/worktreesActivityStore';
import { WorktreesActivitySection } from './WorktreesActivitySection';

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

worktreeActivity.update('s-live', () => ({ worktrees: WORKTREES, pending: undefined, error: undefined }));
worktreeActivity.update('s-busy', () => ({
  worktrees: WORKTREES.slice(0, 1),
  pending: 'starting session…',
  error: undefined,
}));
worktreeActivity.update('s-narrow', () => ({
  worktrees: [
    {
      ...WORKTREES[1],
      branch: 'wt/a-very-long-branch-name-that-should-truncate',
    },
  ],
  pending: undefined,
  error: undefined,
}));

const slot = (sessionId: string | null) => slotPropsFixture({ sessionId }).props;

const meta = {
  title: 'Git/WorktreesActivitySection',
  component: WorktreesActivitySection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex w-80 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">idle · launcher stays</span>
        <WorktreesActivitySection {...slot('s-idle')} />
      </div>

      <div className="flex w-80 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">idle · no focused session</span>
        <WorktreesActivitySection {...slot(null)} />
      </div>

      <div className="flex w-80 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">three worktrees</span>
        <WorktreesActivitySection {...slot('s-live')} />
      </div>

      <div className="flex w-80 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">work in flight</span>
        <WorktreesActivitySection {...slot('s-busy')} />
      </div>

      <div className="flex w-56 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">narrow · long branch</span>
        <WorktreesActivitySection {...slot('s-narrow')} />
      </div>
    </div>
  ),
};

// The real Git group body, seeded for regular, parent and worktree sessions.
const GIT_SESSIONS = [
  { label: 'regular session', id: 'git-main', branch: 'fix/git-branch', added: 120, removed: 34, files: 6 },
  { label: 'parent session with a worktree', id: 'git-parent', branch: 'main', added: 8, removed: 2, files: 1 },
  { label: 'focused worktree session', id: 'git-child', branch: WORKTREES[0].branch, added: 64, removed: 12, files: 4 },
  {
    label: 'clean top-level worktree session',
    id: 'git-clean-child',
    branch: WORKTREES[0].branch,
    added: 0,
    removed: 0,
    files: 0,
  },
];

for (const session of GIT_SESSIONS) {
  gitChanges.update(session.id, () => ({
    changes: {
      branch: session.branch,
      base: 'origin/main',
      added: session.added,
      removed: session.removed,
      files: session.files,
    },
    pending: undefined,
    error: undefined,
    errorTarget: undefined,
  }));
  worktreeActivity.update(session.id, () => ({
    worktrees: session.id === 'git-parent' ? WORKTREES.slice(0, 1) : [],
    pending: undefined,
    error: undefined,
  }));
}
worktreeActivity.update('git-clean-child', (current) => ({
  ...current,
  worktrees: [{ ...WORKTREES[0], sessionId: 'git-clean-child' }],
}));
export const UnifiedGit = {
  render: () => (
    <div className="grid w-fit grid-cols-2 items-start gap-6 bg-doom-bg p-6">
      {GIT_SESSIONS.map((session) => (
        <div key={session.id} className="flex w-80 flex-col gap-2">
          <span className="text-2xs text-doom-dim uppercase tracking-widest">{session.label}</span>
          <div className="flex flex-col gap-2 border-b border-doom-border-soft bg-doom-panel px-3 py-3">
            <div className="flex items-center gap-2 px-1">
              <span aria-hidden className="text-sm font-bold text-doom-faint">
                #
              </span>
              <span className="flex-1 text-sm font-bold text-doom-text">git</span>
              <Kbd className="bg-doom-panel">g w</Kbd>
            </div>
            <WorktreesActivitySection {...slot(session.id)} />
          </div>
        </div>
      ))}
    </div>
  ),
};
