/**
 * The '# git' group's body in the activity dock.
 *
 * DESIGN PATTERNS:
 * - One line per worktree, the same rule the runners rail follows: enough to
 *   notice it, not enough to work with it. The group's own name opens the tab
 *   that has room.
 * - Idle still shows the launcher. A repository with no worktrees is the state
 *   where someone most wants to make one.
 *
 * AVOID:
 * - Doing work here. This section reports and launches; the panel and the tool
 *   own everything else.
 */
import { Button, Dot, Spinner, StatusBadge } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import type { WorktreeView } from '../../types/webWorktrees';
import { worktreeActivity } from '../stores/worktreesActivityStore';
import { worktreesTab } from './WorktreesPanel';

export function WorktreesActivitySection({ sessionId, openTransientTab }: WebPluginSlotProps) {
  const session = useStore(worktreeActivity.store, (state) => worktreeActivity.select(state, sessionId));

  if (session.worktrees.length === 0 && session.pending === undefined) {
    return (
      <div className="flex items-center gap-2 px-1">
        <p data-testid="activity-summary-git" className="px-1 text-xs text-doom-faint">
          idle
        </p>
        {sessionId === null ? null : (
          <Button
            variant="link"
            size="xs"
            data-testid="activity-git-create"
            className="px-0"
            onClick={() => openTransientTab(worktreesTab())}
          >
            create a worktree
          </Button>
        )}
      </div>
    );
  }

  return (
    <div data-testid="activity-git-worktrees" className="flex flex-col gap-0.5">
      {session.pending === undefined ? null : (
        <span className="flex min-w-0 items-center gap-1.5 px-1">
          <Spinner className="h-3 w-3 shrink-0 text-doom-faint" label={session.pending} />
          <span className="min-w-0 truncate text-xs text-doom-dim">{session.pending}</span>
        </span>
      )}
      {session.worktrees.map((worktree: WorktreeView) => (
        <Button
          key={worktree.id}
          variant="ghost"
          size="card"
          data-testid={`activity-git-worktree-${worktree.id}`}
          className="min-w-0 gap-1.5 px-1"
          onClick={() => openTransientTab(worktreesTab())}
        >
          <Dot tone={worktree.orphaned ? 'red' : worktree.sessionId === null ? 'muted' : 'blue'} />
          <span className="min-w-0 flex-1 truncate text-left text-xs font-bold text-doom-hi">{worktree.branch}</span>
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
        </Button>
      ))}
    </div>
  );
}
