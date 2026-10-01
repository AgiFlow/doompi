import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
/**
 * The review tab: this session's changes against its base, the comments on
 * them, and the manual sync beside them.
 *
 * DESIGN PATTERNS:
 * - Opened from the '# diff' group as a transient tab, one per session.
 * - The hub's channel says when something changed (counts, base, a paused
 *   rebase); the panel refetches the file list then, and each file's hunks
 *   when it is opened. Nothing polls.
 * - Comments live in a session store and are cleared only after the host took
 *   the message. Both messages go as `enqueue_automatic`, which queues behind a
 *   running turn instead of failing.
 *
 * AVOID:
 * - Sending sync as a session frame. Sync is a channel command; the hub runs
 *   it with the configured auth, one command per session.
 */
import { buildReviewPrompt } from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useCallback, useEffect, useState } from 'react';

import { gitChanges, requestGitSync } from '../_lib/gitChangesStore';
import { fetchReviewFile, fetchReviewSummary } from '../_lib/gitReviewApi';
import { clearReviewComments, addReviewComment, gitReview, removeReviewComment } from '../_lib/gitReviewStore';
import { conflictPrompt, deliverToAgent, reviewHeading } from '../_lib/gitReviewView';
import { GitReviewView, type ReviewFileState, type ReviewSummaryState } from './GitReviewView';

const REVIEW_TAB_ID = 'git-review';

export function reviewTab(): TransientTab {
  return { id: REVIEW_TAB_ID, label: 'review', panel: GitReviewPanel };
}

export function GitReviewPanel({ sessionId, sendSessionFrame }: WebPluginSlotProps) {
  const activity = useStore(gitChanges.store, (state) => gitChanges.select(state, sessionId));
  const comments = useStore(gitReview.store, (state) => gitReview.select(state, sessionId).comments);
  const [summary, setSummary] = useState<ReviewSummaryState>({ state: 'loading' });
  const [files, setFiles] = useState<Record<string, ReviewFileState | undefined>>({});
  const [sendError, setSendError] = useState<string>();
  const [dismissedError, setDismissedError] = useState<string>();
  const changes = activity.changes;

  // What the hub reported, reduced to the facts that move the file list. A new
  // value means the list and every loaded hunk may be stale.
  const fingerprint = JSON.stringify([
    changes?.branch,
    changes?.base,
    changes?.added,
    changes?.removed,
    changes?.files,
    changes?.rebase?.conflicts.length,
  ]);

  useEffect(() => {
    if (sessionId === null) return;
    const controller = new AbortController();
    fetchReviewSummary(sessionId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setSummary(result.ok ? { state: 'ready', summary: result.summary } : { state: 'error', error: result.error });
        setFiles({});
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSummary({
          state: 'error',
          error: error instanceof Error ? error.message : 'The changes could not be read.',
        });
      });
    return () => controller.abort();
  }, [sessionId, fingerprint]);

  const loadFile = useCallback(
    (path: string): void => {
      if (sessionId === null) return;
      setFiles((current) => ({ ...current, [path]: { state: 'loading' } }));
      const settle = (state: ReviewFileState): void => setFiles((current) => ({ ...current, [path]: state }));
      fetchReviewFile(sessionId, path)
        .then((result) =>
          settle(result.ok ? { state: 'ready', diff: result.diff } : { state: 'error', error: result.error }),
        )
        .catch((error: unknown) =>
          settle({ state: 'error', error: error instanceof Error ? error.message : 'The diff could not be read.' }),
        );
    },
    [sessionId],
  );

  if (sessionId === null) return null;

  const branch = summary.state === 'ready' ? summary.summary.branch : changes?.branch;
  const base = summary.state === 'ready' ? summary.summary.base : changes?.base;
  const error = activity.error === dismissedError ? undefined : activity.error;

  const send = (message: string, onSent?: () => void): void => {
    const failure = deliverToAgent(sendSessionFrame, sessionId, message);
    setSendError(failure);
    if (failure === undefined) onSent?.();
  };

  return (
    <GitReviewView
      sync={{
        ...(changes === undefined ? {} : { changes }),
        ...(activity.pending === undefined ? {} : { pending: activity.pending }),
        ...(error === undefined ? {} : { error }),
        ...(activity.errorTarget === undefined || error === undefined ? {} : { errorTarget: activity.errorTarget }),
        onSync: (action) => requestGitSync(sessionId, action),
        onForcePush: () => requestGitSync(sessionId, 'push', true),
        onAskAgent: () => send(conflictPrompt(branch, changes?.rebase?.conflicts ?? [])),
        onDismissError: () => setDismissedError(activity.error),
      }}
      summary={summary}
      files={files}
      comments={comments}
      onLoadFile={loadFile}
      onAddComment={(comment) => addReviewComment(sessionId, comment)}
      onRemoveComment={(id) => removeReviewComment(sessionId, id)}
      onSendReview={() =>
        send(buildReviewPrompt(comments, reviewHeading(comments.length, branch, base)), () =>
          clearReviewComments(sessionId),
        )
      }
      onDiscard={() => clearReviewComments(sessionId)}
      {...(sendError === undefined ? {} : { sendError })}
    />
  );
}
