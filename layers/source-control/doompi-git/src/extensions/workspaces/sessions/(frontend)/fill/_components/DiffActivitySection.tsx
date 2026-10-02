import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
/**
 * The '# git' group's branch row: this session's code change against its base.
 *
 * DESIGN PATTERNS:
 * - One lane, branch and `+A -R`. Files, base, upstream and a paused rebase live
 *   in the review tab's header, which this lane opens.
 * - Stays clickable at zero, because the review tab is also where pull, push
 *   and rebase live.
 * - Reads the focused session's checkout, whether it is a worktree or not.
 *
 * AVOID:
 * - Doing work here. This section reports and opens the tab.
 */
import { Button, Spinner } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';

import { reviewTab } from '../../_components/GitReviewPanel';
import { gitChanges } from '../../_lib/gitChangesStore';

export function DiffActivitySection({ sessionId, openTransientTab }: WebPluginSlotProps) {
  const session = useStore(gitChanges.store, (state) => gitChanges.select(state, sessionId));
  const changes = session.changes;

  if (sessionId === null || changes === undefined) return null;

  const zero = changes.added === 0 && changes.removed === 0;
  const against = changes.base === undefined ? 'uncommitted' : `vs ${changes.base}`;
  return (
    <div className="flex min-w-0 items-center gap-2 px-1">
      <Button
        variant="ghost"
        size="xs"
        data-testid="activity-diff-changes"
        aria-label={`review ${changes.branch ?? 'detached HEAD'} changes: ${String(changes.added)} added, ${String(changes.removed)} removed ${against}`}
        title={`${String(changes.files)} ${changes.files === 1 ? 'file' : 'files'} ${against}`}
        className={`min-w-0 flex-1 shrink gap-1.5 px-1 text-xs font-bold ${zero ? 'text-doom-faint' : ''}`}
        onClick={() => openTransientTab(reviewTab())}
      >
        <span className="min-w-0 flex-1 truncate text-left text-doom-hi">{changes.branch ?? 'detached HEAD'}</span>
        <span className={zero ? '' : 'text-doom-green'}>+{changes.added}</span>
        <span className={zero ? '' : 'text-doom-red'}>-{changes.removed}</span>
      </Button>
      {session.pending === undefined ? null : (
        <span className="flex min-w-0 items-center gap-1.5">
          <Spinner className="h-3 w-3 shrink-0 text-doom-faint" label={session.pending} />
          <span className="min-w-0 truncate text-xs text-doom-dim">{session.pending}</span>
        </span>
      )}
    </div>
  );
}
