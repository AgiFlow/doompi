/**
 * The review tab's file list: every changed file as a folder tree (the VS Code
 * explorer shape), with its status, its line counts and its comments.
 *
 * DESIGN PATTERNS:
 * - Picking a row scrolls the diff pane to that file; the list never opens a
 *   tab of its own. One tab holds the whole review.
 * - Rows show only the file name, so a long path never truncates away the part
 *   that tells files apart. Folders say the rest; the full path is the tooltip.
 * - Folder chains with a single child collapse into one row (`src/web/lib`),
 *   like VS Code's compact folders, so deep trees stay shallow.
 * - Folders fold on click; a search shows every match with its folders open.
 * - Each row is a button, reachable with Tab; arrow keys move and pick in one
 *   step across the visible files, so the diff follows the cursor.
 *
 * AVOID:
 * - Colour classes outside the token set.
 */
import { Button, ChevronDownIcon, ChevronRightIcon, Input, MessageIcon } from '@agimon-ai/doompi-web-components';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { GitReviewFileEntry, GitReviewFileStatus } from '../../../../../types/gitReview';
import { flattenTree } from '../_lib/gitReviewTree';

const STATUS_MARK: Readonly<Record<GitReviewFileStatus, { letter: string; tone: string; label: string }>> = {
  added: { letter: 'A', tone: 'text-doom-green', label: 'added' },
  modified: { letter: 'M', tone: 'text-doom-yellow', label: 'modified' },
  deleted: { letter: 'D', tone: 'text-doom-red', label: 'deleted' },
  untracked: { letter: 'U', tone: 'text-doom-blue', label: 'untracked' },
  conflicted: { letter: 'C', tone: 'text-doom-red', label: 'conflicted' },
};

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
/** Left padding per depth level; tight so deep files keep room for their names. */
const indent = (depth: number): { paddingLeft: string } => ({ paddingLeft: `${String(0.75 + depth * 0.5)}rem` });

export interface GitReviewBrowserProps {
  files: readonly GitReviewFileEntry[];
  /** The file the diff pane is showing, highlighted here. */
  activePath?: string;
  commentCounts: Readonly<Record<string, number>>;
  onPick: (path: string) => void;
}

export function GitReviewBrowser({ files, activePath, commentCounts, onPick }: GitReviewBrowserProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle === '' ? files : files.filter((file) => file.path.toLocaleLowerCase().includes(needle));
  const rows = flattenTree(shown, (dirPath) => needle !== '' || !collapsed.has(dirPath));
  const ordered = rows.flatMap((row) => (row.kind === 'file' ? [row.file] : []));
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the file the diff is showing in view as the reader scrolls the diff.
  useEffect(() => {
    if (activePath === undefined) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(activePath)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [activePath]);

  const toggle = (dirPath: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(dirPath)) next.add(dirPath);
      return next;
    });
  };
  const allDirs = (): Set<string> =>
    new Set(flattenTree(files, () => true).flatMap((row) => (row.kind === 'dir' ? [row.path] : [])));

  /** Arrow keys pick the neighbouring row and move focus with it, so the diff follows the cursor. */
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (ordered.length === 0) return;
    event.preventDefault();
    const current = ordered.findIndex((file) => file.path === activePath);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = current === -1 ? 0 : (current + step + ordered.length) % ordered.length;
    const file = ordered[next];
    if (file === undefined) return;
    onPick(file.path);
    const list = event.currentTarget.closest('[data-git-review-list]');
    list?.querySelectorAll<HTMLButtonElement>('[data-git-review-row]')[next]?.focus();
  };

  return (
    <nav
      data-testid="git-review-browser"
      aria-label="changed files"
      className="flex min-h-0 w-64 shrink-0 flex-col border-r border-doom-border-soft"
    >
      <div className="flex shrink-0 flex-col gap-1 px-3 pt-2.5 pb-1.5">
        <Input
          data-testid="git-review-search"
          aria-label="search changed file paths"
          size="sm"
          value={query}
          placeholder="search paths…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs text-doom-faint">
            {needle === ''
              ? `${String(files.length)} changed`
              : `${String(shown.length)} of ${String(files.length)} match`}
          </span>
          {needle === '' ? (
            <Button
              variant="link"
              size="xs"
              data-testid="git-review-fold-all"
              className="h-auto px-0"
              onClick={() => setCollapsed(collapsed.size === 0 ? allDirs() : new Set())}
            >
              {collapsed.size === 0 ? 'collapse all' : 'expand all'}
            </Button>
          ) : null}
        </div>
      </div>
      <div ref={listRef} data-git-review-list className="min-h-0 flex-1 overflow-y-auto pb-2">
        {rows.map((row) => {
          if (row.kind === 'dir') {
            const Chevron = row.open ? ChevronDownIcon : ChevronRightIcon;
            return (
              <Button
                key={`dir:${row.path}`}
                variant="ghost"
                size="card"
                aria-expanded={row.open}
                data-testid={`git-review-browser-dir-${row.path}`}
                title={row.path}
                onClick={() => toggle(row.path)}
                style={indent(row.depth)}
                className="min-w-0 flex-row items-center gap-1 rounded-none border-l-2 border-transparent py-1 pr-3 hover:bg-doom-panel/60"
              >
                <Chevron aria-hidden className="h-3 w-3 shrink-0 text-doom-faint" />
                <span className="min-w-0 flex-1 truncate text-xs text-doom-dim">{row.name}</span>
              </Button>
            );
          }
          const { file } = row;
          const mark = STATUS_MARK[file.status];
          const comments = commentCounts[file.path] ?? 0;
          const active = file.path === activePath;
          return (
            <Button
              key={file.path}
              variant="ghost"
              size="card"
              data-git-review-row
              data-path={file.path}
              aria-current={active ? 'true' : undefined}
              data-testid={`git-review-browser-file-${file.path}`}
              title={`${file.path} (${mark.label})`}
              onClick={() => onPick(file.path)}
              onKeyDown={onKeyDown}
              style={indent(row.depth)}
              className={`min-w-0 flex-row items-center gap-1.5 rounded-none border-l-2 py-1 pr-3 ${
                active ? 'border-doom-blue bg-doom-panel' : 'border-transparent hover:bg-doom-panel/60'
              }`}
            >
              <span aria-label={mark.label} className={`w-3 shrink-0 text-center text-2xs font-bold ${mark.tone}`}>
                {mark.letter}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-xs text-doom-hi ${active ? 'font-bold' : ''} ${
                  file.status === 'deleted' ? 'line-through opacity-70' : ''
                }`}
              >
                {baseName(file.path)}
              </span>
              {comments === 0 ? null : (
                <span
                  className="flex shrink-0 items-center gap-0.5 text-2xs text-doom-blue"
                  title={`${String(comments)} comments`}
                >
                  <MessageIcon aria-hidden className="h-2.5 w-2.5" />
                  {comments}
                </span>
              )}
              {file.binary ? (
                <span className="shrink-0 text-2xs text-doom-faint">binary</span>
              ) : (
                <span className="shrink-0 text-2xs">
                  <span className="text-doom-green">+{file.added}</span>{' '}
                  <span className="text-doom-red">-{file.removed}</span>
                </span>
              )}
            </Button>
          );
        })}
        {ordered.length === 0 ? <p className="px-3 py-2 text-2xs text-doom-faint">no path matches</p> : null}
      </div>
    </nav>
  );
}
