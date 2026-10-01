import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
/**
 * The '# diff' group's body: this session's code change against its base.
 *
 * DESIGN PATTERNS:
 * - One lane, `+A -R`. Files, base, upstream and a paused rebase live in the
 *   review tab's header, which this lane and the group's name both open.
 * - Stays clickable at zero, because the review tab is also where pull, push
 *   and rebase live.
 * - Separate from '# git': worktrees are repository management, this is the
 *   session's own change.
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

  if (sessionId === null || changes === undefined) {
    return (
      <p data-testid="activity-summary-diff" className="px-2 text-xs text-doom-faint">
        idle
      </p>
    );
  }

  const zero = changes.added === 0 && changes.removed === 0;
  const against = changes.base === undefined ? 'uncommitted' : `vs ${changes.base}`;
  return (
    <div className="flex min-w-0 items-center gap-2 px-1">
      <Button
        variant="ghost"
        size="xs"
        data-testid="activity-diff-changes"
        aria-label={`review changes: ${String(changes.added)} added, ${String(changes.removed)} removed ${against}`}
        title={`${String(changes.files)} ${changes.files === 1 ? 'file' : 'files'} ${against}`}
        className={`gap-1.5 px-1 text-xs font-bold ${zero ? 'text-doom-faint' : ''}`}
        onClick={() => openTransientTab(reviewTab())}
      >
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
