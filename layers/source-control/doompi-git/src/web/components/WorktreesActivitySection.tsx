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
import { Button } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import type { WorktreeView } from '../../types/webWorktrees.ts';
import { worktreeActivity } from '../stores/worktreesActivityStore.ts';
import { worktreesTab } from './WorktreesPanel.tsx';

export function WorktreesActivitySection({ sessionId, openTransientTab }: WebPluginSlotProps) {
  const session = useStore(worktreeActivity.store, (state) => worktreeActivity.select(state, sessionId));

  if (session.worktrees.length === 0) {
    return (
      <div className="flex items-center gap-2 px-1">
        <p data-testid="activity-summary-git" className="px-1 text-[10px] text-doom-faint">
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
      {session.worktrees.map((worktree: WorktreeView) => (
        <button
          key={worktree.id}
          type="button"
          data-testid={`activity-git-worktree-${worktree.id}`}
          className="flex items-center gap-2 px-1 text-left text-[11px] text-doom-dim hover:text-doom-bright"
          onClick={() => openTransientTab(worktreesTab())}
        >
          <span className="truncate">{worktree.branch}</span>
          {worktree.orphaned ? <span className="text-[10px] text-doom-faint">orphaned</span> : null}
        </button>
      ))}
    </div>
  );
}
