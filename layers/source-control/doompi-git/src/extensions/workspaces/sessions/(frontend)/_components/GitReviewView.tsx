/**
 * The review tab, drawn from what it is handed: the sync header, the changed
 * files on the left, every diff stacked on the right, and one footer that
 * sends every comment as a single message.
 *
 * DESIGN PATTERNS:
 * - Like a pull request's file view. Picking a file in the list scrolls to it;
 *   each file's header stays pinned while its diff scrolls past.
 * - Only nearby file bodies mount and load; distant files retain their headers
 *   and measured-height placeholders.
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
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { GitReviewFileDiff, GitReviewFileEntry, GitReviewSummary } from '../../../../../types/gitReview';
import { GitReviewBrowser } from './GitReviewBrowser';
import { GitSyncBar, type GitSyncBarProps } from './GitSyncBar';

const PICK_ALIGNMENT_MS = 300;
const ESTIMATED_ROW_HEIGHT = 21;
const MAX_DIFF_ROWS = 5_000;

const NO_FILES: readonly GitReviewFileEntry[] = [];
const NO_PATHS: ReadonlySet<string> = new Set();

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
  /** Defer refresh while an unsent draft owns local input state. */
  onDraftChange?: (open: boolean) => void;
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
  onDraftChange,
  sendError,
  initialDraft,
}: GitReviewViewProps) {
  const entries = summary.state === 'ready' ? summary.summary.files : NO_FILES;
  const [openOverride, setOpenOverride] = useState<Readonly<Record<string, boolean>>>({});
  const [picked, setPicked] = useState<string>();
  const [navigation, setNavigation] = useState<string>();
  const [proximity, setProximity] = useState<{ entries: readonly GitReviewFileEntry[]; paths: ReadonlySet<string> }>({
    entries: NO_FILES,
    paths: NO_PATHS,
  });
  const near = proximity.entries === entries ? proximity.paths : NO_PATHS;
  const paneRef = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const pickedAt = useRef(0);
  const activePath = entries.some((entry) => entry.path === picked) ? picked : entries[0]?.path;
  const [draft, setDraft] = useState<{ path: string; selection: DiffSelection } | undefined>(initialDraft);

  useEffect(() => {
    const pane = paneRef.current;
    if (pane === null || typeof IntersectionObserver === 'undefined') return;
    // Observer measurements belong to this summary snapshot.
    // eslint-disable-next-line react/set-state-in-effect
    setHeights(new Map());
    let observer: IntersectionObserver;
    const observe = (): void => {
      observer?.disconnect();
      observer = new IntersectionObserver(
        (changes) => {
          for (const change of changes) {
            if (change.isIntersecting) continue;
            const section = change.target as HTMLElement;
            const path = section.dataset.reviewPath;
            const body = section.querySelector<HTMLElement>('[data-review-body="measured"]');
            if (path !== undefined && body !== null) {
              const height = body.offsetHeight;
              setHeights((measured) => new Map(measured).set(path, height));
            }
          }
          setProximity((current) => {
            const next = new Set(current.entries === entries ? current.paths : NO_PATHS);
            for (const change of changes) {
              const section = change.target as HTMLElement;
              const path = section.dataset.reviewPath;
              if (path === undefined) continue;
              if (change.isIntersecting) next.add(path);
              else {
                next.delete(path);
              }
            }
            return { entries, paths: next };
          });
        },
        { root: pane, rootMargin: `${String(pane.clientHeight)}px 0px` },
      );
      for (const section of pane.querySelectorAll('[data-review-path]')) observer.observe(section);
    };
    observe();
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(observe);
    resize?.observe(pane);
    let frame = 0;
    const scroll = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // ponytail: a short alignment lock keeps explicit picks authoritative; use scrollend for longer animated navigation.
        if (Date.now() - pickedAt.current < PICK_ALIGNMENT_MS) return;
        const rect = pane.getBoundingClientRect();
        const section = document
          .elementFromPoint(rect.left + 8, rect.top + 1)
          ?.closest<HTMLElement>('[data-review-path]');
        if (section !== null && section !== undefined && pane.contains(section)) setPicked(section.dataset.reviewPath);
      });
    };
    pane.addEventListener('scroll', scroll, { passive: true });
    return () => {
      observer.disconnect();
      resize?.disconnect();
      pane.removeEventListener('scroll', scroll);
      cancelAnimationFrame(frame);
    };
  }, [entries]);

  useLayoutEffect(() => {
    if (navigation === undefined) return;
    const section = [...(paneRef.current?.querySelectorAll<HTMLElement>('[data-review-path]') ?? [])].find(
      (element) => element.dataset.reviewPath === navigation,
    );
    section?.scrollIntoView({ block: 'start' });
  }, [navigation, openOverride]);

  useEffect(() => {
    if (navigation === undefined) return;
    const timeout = setTimeout(() => setNavigation(undefined), PICK_ALIGNMENT_MS);
    return () => clearTimeout(timeout);
  }, [navigation]);

  useEffect(() => {
    for (const file of entries) {
      if (
        (openOverride[file.path] ?? true) &&
        (near.has(file.path) || navigation === file.path || draft?.path === file.path) &&
        files[file.path] === undefined
      )
        onLoadFile(file.path);
    }
  }, [entries, files, near, navigation, draft, openOverride, onLoadFile]);

  const commentCounts: Record<string, number> = {};
  for (const comment of comments) commentCounts[comment.path] = (commentCounts[comment.path] ?? 0) + 1;

  const isOpen = (path: string): boolean => openOverride[path] ?? true;

  const open = (path: string): void => {
    setOpenOverride((current) => (current[path] === true ? current : { ...current, [path]: true }));
  };

  const pick = (path: string): void => {
    if (!entries.some((entry) => entry.path === path)) return;
    pickedAt.current = Date.now();
    setPicked(path);
    setNavigation(path);
    open(path);
  };

  const toggle = (path: string): void => {
    if (isOpen(path)) setOpenOverride((current) => ({ ...current, [path]: false }));
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
    onDraftChange?.(false);
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
          <div ref={paneRef} data-testid="git-review-diffs" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
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
                collapsed={!isOpen(file.path)}
                mounted={near.has(file.path) || navigation === file.path || draft?.path === file.path}
                placeholderHeight={
                  heights.get(file.path) ??
                  (file.binary ? 40 : Math.min(MAX_DIFF_ROWS, file.added + file.removed + 6) * ESTIMATED_ROW_HEIGHT)
                }
                comments={comments.filter((comment) => comment.path === file.path)}
                draft={draft?.path === file.path ? draft.selection : undefined}
                onToggle={() => toggle(file.path)}
                onSelect={(selection) => {
                  setPicked(file.path);
                  setDraft({ path: file.path, selection });
                  onDraftChange?.(true);
                }}
                onSubmitDraft={submitDraft}
                onCancelDraft={() => {
                  setDraft(undefined);
                  onDraftChange?.(false);
                }}
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
  mounted,
  placeholderHeight,
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
  mounted: boolean;
  placeholderHeight: number;
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
    <section
      id={id}
      data-review-path={entry.path}
      data-testid={`git-review-file-${entry.path}`}
      className="border-b border-doom-border-soft"
    >
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
      {/* ponytail: file bodies are windowed; visible files retain the server's 5,000-row ceiling. Virtualize rows if needed. */}
      {collapsed ? null : !mounted ? (
        <div aria-hidden style={{ height: placeholderHeight }} />
      ) : (
        <div
          data-review-body={state === undefined || state.state === 'loading' ? 'loading' : 'measured'}
          style={state === undefined || state.state === 'loading' ? { minHeight: placeholderHeight } : undefined}
        >
          {state === undefined || state.state === 'loading' ? (
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
        </div>
      )}
    </section>
  );
}
