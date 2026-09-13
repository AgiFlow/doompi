import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
/**
 * The '# git' group's tab: this session's worktrees, and the form that makes one.
 *
 * DESIGN PATTERNS:
 * - Lives in the activity dock, opened by the group's name. A worktree is work
 *   in progress belonging to the session that started it, so it sits beside
 *   agents, runners and workflows rather than in a settings screen.
 * - Header, form, then cards, the same rhythm the runners and workflows panels
 *   use. A worktree row is a card because it carries three facts and two
 *   actions, which a single line cannot hold without becoming a puzzle.
 * - Local form state is never reset by a data refresh. The hub republishes this
 *   list on a timer, and a half-typed branch name must survive that.
 * - Acts through the plugin's own hub channel, so a worktree made here and one
 *   made by the tool take exactly the same path.
 * - Creating waits on the cockpit starting a session, so the hub reports each
 *   phase on that channel and the header shows it turning. A button that looks
 *   idle for two minutes reads as broken.
 *
 * AVOID:
 * - Deriving form state from props or store data. That is what wiped the
 *   fields on every poll.
 * - Colour classes outside the token set. `doom-error`, `doom-line` and
 *   `doom-bright` are not tokens: they compile to nothing and the row silently
 *   loses its border.
 */
import { Button, Dot, EmptyState, Input, Spinner, StatusBadge } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useState } from 'react';

import type { WorktreeView } from '../../types/webWorktrees';
import { requestWorktreeClose, requestWorktreeCreate, worktreeActivity } from '../stores/worktreesActivityStore';

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
    <div data-testid="git-worktrees-panel" className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex min-h-11 shrink-0 items-center gap-2.5 border-b border-doom-border-soft px-3 sm:px-[26px]">
        <span className="text-sm font-bold text-doom-hi">worktrees</span>
        <span data-testid="git-worktrees-count" className="text-xs text-doom-faint">
          {session.worktrees.length === 0 ? 'none yet' : `${String(session.worktrees.length)} open`}
        </span>
        <span className="min-w-0 flex-1" />
        {session.pending === undefined ? null : (
          <span data-testid="git-worktree-pending" className="flex min-w-0 items-center gap-1.5">
            <Spinner className="h-3 w-3 shrink-0 text-doom-faint" label={session.pending} />
            <span className="min-w-0 truncate text-xs text-doom-dim">{session.pending}</span>
          </span>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 border-b border-doom-border-soft px-3 py-2.5 sm:px-[26px]">
        <div className="flex items-center gap-2">
          <Input
            data-testid="git-worktree-branch"
            aria-label="Branch"
            size="sm"
            className="min-w-0 flex-1"
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
            size="sm"
            placeholder="base (current)"
            value={baseRef}
            onChange={(event) => setBaseRef(event.target.value)}
            className="w-32 shrink-0"
          />
          <Button data-testid="git-worktree-create" size="sm" disabled={!canCreate} onClick={create}>
            Create
          </Button>
        </div>
        {session.error === undefined ? (
          <p className="text-2xs text-doom-faint">
            Creates the worktree outside the repository and starts a session nested under this one.
          </p>
        ) : (
          <p data-testid="git-worktree-error" className="text-2xs text-doom-red">
            {session.error}
          </p>
        )}
      </div>

      {session.worktrees.length === 0 ? (
        <EmptyState
          data-testid="git-worktrees-empty"
          className="px-4 py-8"
          title="no worktrees yet"
          description="a worktree is its own checkout on its own branch, with its own session nested under this one."
        />
      ) : (
        <ul data-testid="git-worktrees-list" className="flex flex-col gap-2.5 px-3 py-3 sm:px-[26px]">
          {session.worktrees.map((worktree: WorktreeView) => (
            <WorktreeCard key={worktree.id} worktree={worktree} sessionId={sessionId} busy={busy} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One worktree: what it is, where it is, and the one thing you can do to it. */
function WorktreeCard({
  worktree,
  sessionId,
  busy,
}: {
  worktree: WorktreeView;
  busy: boolean;
} & Pick<WebPluginSlotProps, 'sessionId'>) {
  return (
    <li
      data-testid={`git-worktree-${worktree.id}`}
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-doom-border-soft bg-doom-panel p-2.5"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Dot tone={worktree.orphaned ? 'red' : worktree.sessionId === null ? 'muted' : 'blue'} />
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-doom-hi">{worktree.branch}</span>
        {worktree.orphaned ? (
          <StatusBadge tone="error" size="xs">
            orphaned
          </StatusBadge>
        ) : null}
        {worktree.unowned ? (
          <StatusBadge tone="info" size="xs">
            unowned
          </StatusBadge>
        ) : null}
      </div>

      <span className="min-w-0 truncate text-2xs text-doom-faint">{worktree.path}</span>

      <div className="flex items-center gap-1.5 pt-0.5">
        <span className="min-w-0 flex-1" />
        {sessionId === null ? null : (
          <Button
            variant="danger-outline"
            size="xs"
            disabled={busy}
            data-testid={`git-worktree-close-${worktree.id}`}
            className="px-2 text-2xs font-bold"
            onClick={() => requestWorktreeClose(sessionId, worktree.id)}
          >
            close
          </Button>
        )}
      </div>
    </li>
  );
}
