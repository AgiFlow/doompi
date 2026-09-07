/**
 * The '# git' group's tab: this session's worktrees, and the form that makes one.
 *
 * DESIGN PATTERNS:
 * - Lives in the activity dock, opened by the group's name. A worktree is work
 *   in progress belonging to the session that started it, so it sits beside
 *   agents, runners and workflows rather than in a settings screen.
 * - Local form state is never reset by a data refresh. The hub republishes this
 *   list on a timer, and a half-typed branch name must survive that.
 * - Acts through the plugin's own hub channel, so a worktree made here and one
 *   made by the tool take exactly the same path.
 * - Creating takes minutes, so the hub reports progress and failure on that
 *   channel and this panel renders both. A button that looks idle for two
 *   minutes reads as broken.
 *
 * AVOID:
 * - Deriving form state from props or store data. That is what wiped the
 *   fields on every poll.
 */
import { Button, Input } from '@agimon-ai/doompi-web-components';
import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useState } from 'react';
import type { WorktreeView } from '../../types/webWorktrees.ts';
import { requestWorktreeClose, requestWorktreeCreate, worktreeActivity } from '../stores/worktreesActivityStore.ts';

const WORKTREES_TAB_ID = 'git-worktrees';

export function worktreesTab(): TransientTab {
  return { id: WORKTREES_TAB_ID, label: 'worktrees', panel: WorktreesPanel };
}

export function WorktreesPanel({ sessionId }: WebPluginSlotProps) {
  const session = useStore(worktreeActivity.store, (state) => worktreeActivity.select(state, sessionId));
  const [branch, setBranch] = useState('');
  const [baseRef, setBaseRef] = useState('');

  const busy = session.pending !== undefined;
  const canCreate = sessionId !== null && branch.trim() !== '' && !busy;

  const create = (): void => {
    if (sessionId === null || !canCreate) return;
    requestWorktreeCreate(sessionId, branch, baseRef);
    setBranch('');
    setBaseRef('');
  };

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="git-worktrees-panel">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Input
            data-testid="git-worktree-branch"
            aria-label="Branch"
            placeholder="wt/fix-auth"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') create();
            }}
          />
          <Input
            data-testid="git-worktree-base"
            aria-label="Base ref"
            placeholder="base (current)"
            value={baseRef}
            onChange={(event) => setBaseRef(event.target.value)}
            className="w-40"
          />
          <Button data-testid="git-worktree-create" size="xs" disabled={!canCreate} onClick={create}>
            Create
          </Button>
        </div>
        <p className="text-[10px] text-doom-faint">
          Creates the worktree outside the repository, installs its dependencies, then starts a session nested under
          this one. The install is what makes the wait; a warm store is under a minute.
        </p>
        {session.pending === undefined ? null : (
          <p data-testid="git-worktree-pending" className="text-[10px] text-doom-dim">
            {session.pending}
          </p>
        )}
        {session.error === undefined ? null : (
          <p data-testid="git-worktree-error" className="text-[10px] text-doom-error">
            {session.error}
          </p>
        )}
      </div>

      {session.worktrees.length === 0 ? (
        <p className="text-[11px] text-doom-faint">No worktrees yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {session.worktrees.map((worktree: WorktreeView) => (
            <li
              key={worktree.id}
              data-testid={`git-worktree-${worktree.id}`}
              className="flex items-center justify-between gap-2 border border-doom-line px-2 py-1"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[11px] text-doom-bright">{worktree.branch}</span>
                <span className="truncate text-[10px] text-doom-faint">{worktree.path}</span>
              </div>
              <div className="flex items-center gap-2">
                {worktree.orphaned ? <span className="text-[10px] text-doom-faint">orphaned</span> : null}
                {worktree.unowned ? <span className="text-[10px] text-doom-faint">unowned</span> : null}
                {sessionId === null ? null : (
                  <Button
                    variant="link"
                    size="xs"
                    disabled={busy}
                    data-testid={`git-worktree-close-${worktree.id}`}
                    onClick={() => requestWorktreeClose(sessionId, worktree.id)}
                  >
                    close
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
