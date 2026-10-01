/**
 * The review tab, drawn from what it is handed: the sync header, the changed
 * files on the left, every diff stacked on the right, and one footer that
 * sends every comment as a single message.
 *
 * DESIGN PATTERNS:
 * - Like a pull request's file view. Picking a file in the list scrolls to it;
 *   each file's header stays pinned while its diff scrolls past.
 * - The first files load at once and the rest load when opened, so a branch
 *   with hundreds of changed files does not fetch hundreds of diffs up front.
 * - A comment is drawn under the line it is about, on the side it is about.
 *   The open draft sits in the same place, so writing happens in context.
 * - Only UI state lives here (the open draft, which files are collapsed, which
 *   is active). Data and comments come in as props; the panel owns fetching.
 *
 * AVOID:
 * - Clearing comments here. The owner clears them once the host took the send.
 */
import {
  Button,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  DiffView,
  EmptyState,
  MessageIcon,
  ReviewCommentDraft,
  Spinner,
  reviewCommentAnchor,
  type DiffRow,
  type DiffSelection,
  type ReviewComment,
} from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';

import type { GitReviewFileDiff, GitReviewFileEntry, GitReviewSummary } from '../../../../../types/gitReview';
import { GitReviewBrowser } from './GitReviewBrowser';
import { GitSyncBar, type GitSyncBarProps } from './GitSyncBar';

/** How many files load their diff before the reader asks for more. */
export const EAGER_FILES = 20;

const NO_FILES: readonly GitReviewFileEntry[] = [];

export type ReviewSummaryState =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ready'; summary: GitReviewSummary };

export type ReviewFileState =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ready'; diff: GitReviewFileDiff };

export interface GitReviewViewProps {
  sync: GitSyncBarProps;
  summary: ReviewSummaryState;
  files: Readonly<Record<string, ReviewFileState | undefined>>;
  comments: readonly ReviewComment[];
  onLoadFile: (path: string) => void;
  onAddComment: (comment: Omit<ReviewComment, 'id'>) => void;
  onRemoveComment: (id: string) => void;
  onSendReview: () => void;
  onDiscard: () => void;
  /** Why the last send did not reach the session; the comments are still here. */
  sendError?: string;
  /** Opens with this draft already raised. Stories use it; the panel never does. */
  initialDraft?: { path: string; selection: DiffSelection };
}

/** Stable, URL-safe element id for one file's section. */
function sectionId(index: number): string {
  return `git-review-file-${String(index)}`;
}

function sideOf(row: DiffRow): 'old' | 'new' {
  return row.marker === '-' ? 'old' : 'new';
}

export function GitReviewView({
  sync,
  summary,
  files,
  comments,
  onLoadFile,
  onAddComment,
  onRemoveComment,
  onSendReview,
  onDiscard,
  sendError,
  initialDraft,
}: GitReviewViewProps) {
  const entries = summary.state === 'ready' ? summary.summary.files : NO_FILES;
  // A file is open by default when it is among the first EAGER_FILES; the
  // reader's own toggles override that, so a list that arrives later still
  // opens exactly the files that load.
  const [openOverride, setOpenOverride] = useState<Readonly<Record<string, boolean>>>({});
  const [picked, setPicked] = useState<string | undefined>();
  const activePath = picked ?? entries[0]?.path;
  const [draft, setDraft] = useState<{ path: string; selection: DiffSelection } | undefined>(initialDraft);

  // The eager slice loads as soon as the list arrives; anything already asked
  // for is left alone, so a re-render never refetches.
  useEffect(() => {
    for (const file of entries.slice(0, EAGER_FILES)) {
      if (files[file.path] === undefined) onLoadFile(file.path);
    }
  }, [entries, files, onLoadFile]);

  const commentCounts: Record<string, number> = {};
  for (const comment of comments) commentCounts[comment.path] = (commentCounts[comment.path] ?? 0) + 1;

  const isOpen = (path: string, index: number): boolean => openOverride[path] ?? index < EAGER_FILES;

  const open = (path: string): void => {
    setOpenOverride((current) => (current[path] === true ? current : { ...current, [path]: true }));
    if (files[path] === undefined) onLoadFile(path);
  };

  const pick = (path: string): void => {
    setPicked(path);
    open(path);
    const index = entries.findIndex((file) => file.path === path);
    globalThis.document?.getElementById(sectionId(index))?.scrollIntoView({ block: 'start' });
  };

  const toggle = (path: string, index: number): void => {
    if (isOpen(path, index)) setOpenOverride((current) => ({ ...current, [path]: false }));
    else open(path);
  };

  const submitDraft = (body: string): void => {
    if (draft === undefined) return;
    onAddComment({
      path: draft.path,
      relPath: draft.path,
      side: draft.selection.side,
      startLine: draft.selection.startLine,
      endLine: draft.selection.endLine,
      snippet: draft.selection.snippet,
      body: body.trim(),
    });
    setDraft(undefined);
  };

  return (
    <div data-testid="git-review-panel" className="flex min-h-0 flex-1 flex-col">
      <GitSyncBar
        {...sync}
        {...(summary.state === 'ready' && summary.summary.mergeBase !== undefined
          ? { mergeBase: summary.summary.mergeBase }
          : {})}
      />

      {summary.state === 'loading' ? (
        <div data-testid="git-review-loading" className="flex flex-1 items-start gap-2 px-4 py-6">
          <Spinner className="h-3 w-3 text-doom-faint" label="reading changes" />
          <span className="text-xs text-doom-dim">reading changes…</span>
        </div>
      ) : summary.state === 'error' ? (
        <p role="alert" data-testid="git-review-error" className="flex-1 px-4 py-6 text-xs text-doom-red">
          {summary.error}
        </p>
      ) : !summary.summary.repository ? (
        <EmptyState
          data-testid="git-review-no-repository"
          className="px-4 py-8"
          title="not a git checkout"
          description="this session's folder is not inside a git repository, so there is nothing to review."
        />
      ) : entries.length === 0 ? (
        <EmptyState
          data-testid="git-review-empty"
          className="px-4 py-8"
          title="no changes"
          description={
            summary.summary.base === undefined
              ? 'nothing uncommitted in this checkout.'
              : `nothing differs from ${summary.summary.base}, committed or not.`
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <GitReviewBrowser
            files={entries}
            commentCounts={commentCounts}
            onPick={pick}
            {...(activePath === undefined ? {} : { activePath })}
          />
          <div data-testid="git-review-diffs" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {summary.summary.truncated ? (
              <p className="px-4 pt-2 text-2xs text-doom-faint">
                more files changed than the review lists; the rest are left out.
              </p>
            ) : null}
            {entries.map((file, index) => (
              <FileSection
                key={file.path}
                id={sectionId(index)}
                entry={file}
                state={files[file.path]}
                collapsed={!isOpen(file.path, index)}
                comments={comments.filter((comment) => comment.path === file.path)}
                draft={draft?.path === file.path ? draft.selection : undefined}
                onToggle={() => toggle(file.path, index)}
                onSelect={(selection) => {
                  setPicked(file.path);
                  setDraft({ path: file.path, selection });
                }}
                onSubmitDraft={submitDraft}
                onCancelDraft={() => setDraft(undefined)}
                onRemoveComment={onRemoveComment}
                onRetry={() => onLoadFile(file.path)}
              />
            ))}
          </div>
        </div>
      )}

      <div
        data-testid="git-review-footer"
        className="flex shrink-0 flex-wrap items-center gap-2 border-t border-doom-border-soft bg-doom-panel px-3 py-2 sm:px-[26px]"
      >
        <MessageIcon aria-hidden className="h-3 w-3 text-doom-faint" />
        <span data-testid="git-review-comment-count" className="text-xs text-doom-dim">
          {comments.length === 0
            ? 'no comments yet: select lines or click a line number'
            : `${String(comments.length)} ${comments.length === 1 ? 'comment' : 'comments'}`}
        </span>
        <span className="min-w-0 flex-1" />
        {sendError === undefined ? null : (
          <span role="alert" data-testid="git-review-send-error" className="min-w-0 truncate text-2xs text-doom-red">
            {sendError}
          </span>
        )}
        <Button
          variant="ghost"
          size="xs"
          data-testid="git-review-discard"
          disabled={comments.length === 0}
          onClick={onDiscard}
        >
          discard
        </Button>
        <Button
          variant="primary"
          size="sm"
          data-testid="git-review-send"
          disabled={comments.length === 0}
          onClick={onSendReview}
        >
          send review
        </Button>
      </div>
    </div>
  );
}

const STATUS_WORD: Readonly<Record<GitReviewFileEntry['status'], string>> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  untracked: 'new, untracked',
  conflicted: 'conflicted',
};

/** One file: a pinned header, then its diff with comments drawn under the lines they are about. */
function FileSection({
  id,
  entry,
  state,
  collapsed,
  comments,
  draft,
  onToggle,
  onSelect,
  onSubmitDraft,
  onCancelDraft,
  onRemoveComment,
  onRetry,
}: {
  id: string;
  entry: GitReviewFileEntry;
  state: ReviewFileState | undefined;
  collapsed: boolean;
  comments: readonly ReviewComment[];
  draft: DiffSelection | undefined;
  onToggle: () => void;
  onSelect: (selection: DiffSelection) => void;
  onSubmitDraft: (body: string) => void;
  onCancelDraft: () => void;
  onRemoveComment: (id: string) => void;
  onRetry: () => void;
}) {
  const renderAfterRow = (row: DiffRow) => {
    const side = sideOf(row);
    const here = comments.filter(
      (comment) => (comment.side ?? 'new') === side && (comment.endLine ?? comment.startLine) === row.line,
    );
    const drafting = draft !== undefined && draft.side === side && draft.endLine === row.line;
    if (here.length === 0 && !drafting) return null;
    return (
      <div className="flex flex-col gap-1.5 border-y border-doom-border-soft bg-doom-bg px-2 py-1.5 whitespace-normal">
        {here.map((comment) => (
          <div
            key={comment.id}
            data-testid={`git-review-comment-${comment.id}`}
            className="flex min-w-0 items-start gap-2 rounded-md border border-doom-border-soft bg-doom-panel px-2 py-1.5"
          >
            <MessageIcon aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-doom-blue" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-2xs text-doom-faint">{reviewCommentAnchor(comment)}</span>
              <span className="text-xs whitespace-pre-wrap text-doom-hi">{comment.body}</span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="remove comment"
              title="remove comment"
              onClick={() => onRemoveComment(comment.id)}
            >
              <CloseIcon className="h-3 w-3" />
            </Button>
          </div>
        ))}
        {drafting ? (
          <div className="rounded-md border border-doom-border bg-doom-panel">
            <ReviewCommentDraft
              snippet={draft.snippet}
              startLine={draft.startLine}
              endLine={draft.endLine}
              side={draft.side}
              testIdPrefix="git-review-comment"
              onSubmit={onSubmitDraft}
              onCancel={onCancelDraft}
            />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section id={id} data-testid={`git-review-file-${entry.path}`} className="border-b border-doom-border-soft">
      <Button
        variant="ghost"
        size="card"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="sticky top-0 z-10 flex-row items-center gap-1.5 rounded-none border-b border-doom-border-soft bg-doom-rail px-3 py-1.5 hover:bg-doom-panel sm:px-4"
      >
        {collapsed ? (
          <ChevronRightIcon aria-hidden className="h-3 w-3 shrink-0 text-doom-faint" />
        ) : (
          <ChevronDownIcon aria-hidden className="h-3 w-3 shrink-0 text-doom-faint" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-bold text-doom-hi">{entry.path}</span>
        <span className="shrink-0 text-2xs text-doom-faint">{STATUS_WORD[entry.status]}</span>
        {comments.length === 0 ? null : (
          <span className="flex shrink-0 items-center gap-0.5 text-2xs text-doom-blue">
            <MessageIcon aria-hidden className="h-2.5 w-2.5" />
            {comments.length}
          </span>
        )}
        {entry.binary ? null : (
          <span className="shrink-0 text-2xs">
            <span className="text-doom-green">+{entry.added}</span>{' '}
            <span className="text-doom-red">-{entry.removed}</span>
          </span>
        )}
      </Button>
      {collapsed ? null : state === undefined || state.state === 'loading' ? (
        <div className="flex items-center gap-2 px-4 py-3">
          <Spinner className="h-3 w-3 text-doom-faint" label={`loading ${entry.path}`} />
          <span className="text-2xs text-doom-faint">loading diff…</span>
        </div>
      ) : state.state === 'error' ? (
        <div className="flex items-center gap-2 px-4 py-3">
          <span role="alert" className="text-2xs text-doom-red">
            {state.error}
          </span>
          <Button variant="ghost" size="xs" onClick={onRetry}>
            retry
          </Button>
        </div>
      ) : state.diff.binary ? (
        <p className="px-4 py-3 text-2xs text-doom-faint">binary file, not drawn</p>
      ) : state.diff.tooLarge ? (
        <p className="px-4 py-3 text-2xs text-doom-faint">this diff is too large to draw here</p>
      ) : (
        <DiffView
          hunks={state.diff.hunks}
          testId={`git-review-diff-${id}`}
          onSelect={onSelect}
          renderAfterRow={renderAfterRow}
          className="py-1"
        />
      )}
    </section>
  );
}
