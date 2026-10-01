/**
 * The review tab's header: what is being reviewed, and the manual sync that
 * goes with it.
 *
 * DESIGN PATTERNS:
 * - Everything here is a report or a request. The hub runs the git, one
 *   command per session, and answers on the channel: pending while it runs,
 *   an error target when it fails, a paused rebase when it stops on conflicts.
 * - A push the remote rejects is not an error to shrug at: the strip asks
 *   before forcing, and the force it sends is a lease, which git refuses if
 *   the remote holds commits this branch never fetched and integrated.
 * - A paused rebase blocks the sync buttons. The two ways out are named on the
 *   banner, and abort says what it throws away.
 *
 * AVOID:
 * - Colour classes outside the token set.
 */
import { AlertIcon, BranchIcon, Button, Spinner, StatusBadge } from '@agimon-ai/doompi-web-components';

import type { GitChangesView, GitSyncAction, GitSyncErrorTarget } from '../../../../../types/gitReview';

export interface GitSyncBarProps {
  /** Absent until the hub has reported this session's checkout. */
  changes?: GitChangesView;
  /** Short sha the review diff starts from. */
  mergeBase?: string;
  /** Label of the command the hub is running. */
  pending?: string;
  error?: string;
  errorTarget?: GitSyncErrorTarget;
  onSync: (action: GitSyncAction) => void;
  onForcePush: () => void;
  onAskAgent: () => void;
  onDismissError: () => void;
}

export function GitSyncBar({
  changes,
  mergeBase,
  pending,
  error,
  errorTarget,
  onSync,
  onForcePush,
  onAskAgent,
  onDismissError,
}: GitSyncBarProps) {
  const busy = pending !== undefined;
  const paused = changes?.rebase !== undefined;
  const forceRequired =
    errorTarget?.action === 'push' && 'forceRequired' in errorTarget && errorTarget.forceRequired === true;
  const syncError = error !== undefined && !forceRequired ? error : undefined;
  const upstream = changes?.upstream;

  return (
    <div
      data-testid="git-sync-bar"
      className="flex shrink-0 flex-col gap-2 border-b border-doom-border-soft px-3 py-2.5 sm:px-[26px]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <BranchIcon aria-hidden className="h-3.5 w-3.5 shrink-0 text-doom-faint" />
          <span data-testid="git-review-branch" className="truncate text-sm font-bold text-doom-hi">
            {changes?.branch ?? 'detached HEAD'}
          </span>
          <span className="shrink-0 text-xs text-doom-faint">
            {changes?.base === undefined ? 'uncommitted changes' : `vs ${changes.base}`}
          </span>
          {mergeBase === undefined ? null : <span className="shrink-0 text-2xs text-doom-faint">from {mergeBase}</span>}
        </span>
        {changes === undefined ? null : (
          <span data-testid="git-review-totals" className="flex shrink-0 items-center gap-1.5 text-xs">
            <span className="font-bold text-doom-green">+{changes.added}</span>
            <span className="font-bold text-doom-red">-{changes.removed}</span>
            <span className="text-doom-faint">
              {changes.files}
              {changes.truncated ? '+' : ''} {changes.files === 1 ? 'file' : 'files'}
            </span>
          </span>
        )}
        <span className="min-w-0 flex-1" />
        {upstream === undefined ? (
          <span className="shrink-0 text-2xs text-doom-faint">no upstream yet</span>
        ) : (
          <span className="shrink-0 text-2xs text-doom-faint" title={upstream.ref}>
            ↑{upstream.ahead} ↓{upstream.behind} {upstream.ref}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5">
          <Button
            size="xs"
            data-testid="git-sync-pull"
            disabled={busy || paused || upstream === undefined}
            title={upstream === undefined ? 'push once to set an upstream' : `fetch, then rebase onto ${upstream.ref}`}
            onClick={() => onSync('pull')}
          >
            pull
          </Button>
          <Button
            size="xs"
            data-testid="git-sync-push"
            disabled={busy || paused || changes?.branch === undefined}
            title={upstream === undefined ? 'push and set the upstream' : `push to ${upstream.ref}`}
            onClick={() => onSync('push')}
          >
            push
          </Button>
          <Button
            size="xs"
            data-testid="git-sync-rebase"
            disabled={busy || paused || changes?.base === undefined}
            title={
              changes?.base === undefined ? 'no base branch to rebase onto' : `fetch, then rebase onto ${changes.base}`
            }
            onClick={() => onSync('rebase')}
          >
            rebase
          </Button>
        </span>
      </div>

      {pending === undefined ? null : (
        <span data-testid="git-sync-pending" className="flex min-w-0 items-center gap-1.5">
          <Spinner className="h-3 w-3 shrink-0 text-doom-faint" label={pending} />
          <span className="min-w-0 truncate text-xs text-doom-dim">{pending}</span>
        </span>
      )}

      {syncError === undefined ? null : (
        <div
          role="alert"
          data-testid="git-sync-error"
          className="flex min-w-0 items-start gap-1.5 text-2xs text-doom-red"
        >
          <AlertIcon aria-hidden className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1">{syncError}</span>
          <Button variant="ghost" size="xs" className="h-auto min-h-0 px-1 py-0 text-2xs" onClick={onDismissError}>
            dismiss
          </Button>
        </div>
      )}

      {forceRequired ? (
        <div
          data-testid="git-push-force-confirm"
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-doom-edge-yellow bg-doom-tint-yellow px-2.5 py-2"
        >
          <span className="min-w-0 flex-1 text-xs text-doom-hi">
            The remote branch has commits yours replaced, usually after a rebase. Force push with lease? It is refused
            if the remote holds commits you never fetched and integrated.
          </span>
          <Button variant="danger-outline" size="xs" data-testid="git-push-force" disabled={busy} onClick={onForcePush}>
            force push
          </Button>
          <Button variant="ghost" size="xs" data-testid="git-push-force-cancel" onClick={onDismissError}>
            cancel
          </Button>
        </div>
      ) : null}

      {changes?.rebase === undefined ? null : (
        <div
          data-testid="git-rebase-banner"
          className="flex min-w-0 flex-col gap-1.5 rounded-md border border-doom-edge-red bg-doom-tint-red px-2.5 py-2"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <StatusBadge tone="error" size="xs">
              rebase paused
            </StatusBadge>
            <span className="text-xs text-doom-hi">
              {changes.rebase.conflicts.length === 0
                ? 'git stopped the rebase'
                : `conflicts in ${String(changes.rebase.conflicts.length)} ${changes.rebase.conflicts.length === 1 ? 'file' : 'files'}`}
            </span>
          </span>
          {changes.rebase.conflicts.length === 0 ? null : (
            <ul className="flex flex-col gap-0.5 pl-1">
              {changes.rebase.conflicts.map((file) => (
                <li key={file} className="truncate font-mono text-2xs text-doom-dim">
                  {file}
                </li>
              ))}
            </ul>
          )}
          <span className="flex flex-wrap items-center gap-1.5">
            <Button variant="primary" size="xs" data-testid="git-rebase-ask-agent" disabled={busy} onClick={onAskAgent}>
              ask agent to resolve
            </Button>
            <Button
              variant="danger-outline"
              size="xs"
              data-testid="git-rebase-abort"
              disabled={busy}
              onClick={() => onSync('abort-rebase')}
            >
              abort rebase
            </Button>
            <span className="text-2xs text-doom-faint">abort discards any conflict resolution in progress</span>
          </span>
        </div>
      )}
    </div>
  );
}
