/**
 * The review tab's file list: every changed file, grouped the way the files
 * drawer groups them, with its status, its line counts and its comments.
 *
 * DESIGN PATTERNS:
 * - Picking a row scrolls the diff pane to that file; the list never opens a
 *   tab of its own. One tab holds the whole review.
 * - Grouped while the whole list is in view, flat while a search is active:
 *   a reader searching is pinpointing one path, and headers around two matches
 *   only get in the way.
 * - Each row is a button, reachable with Tab; arrow keys move and pick in one
 *   step, so the diff follows the cursor.
 *
 * AVOID:
 * - Colour classes outside the token set.
 */
import { Button, groupByDirectory, groupRowLabel, Input, MessageIcon } from '@agimon-ai/doompi-web-components';
import { useState, type KeyboardEvent } from 'react';

import type { GitReviewFileEntry, GitReviewFileStatus } from '../../../../../types/gitReview';

const STATUS_MARK: Readonly<Record<GitReviewFileStatus, { letter: string; tone: string; label: string }>> = {
  added: { letter: 'A', tone: 'text-doom-green', label: 'added' },
  modified: { letter: 'M', tone: 'text-doom-yellow', label: 'modified' },
  deleted: { letter: 'D', tone: 'text-doom-red', label: 'deleted' },
  untracked: { letter: 'U', tone: 'text-doom-blue', label: 'untracked' },
  conflicted: { letter: 'C', tone: 'text-doom-red', label: 'conflicted' },
};

export interface GitReviewBrowserProps {
  files: readonly GitReviewFileEntry[];
  /** The file the diff pane is showing, highlighted here. */
  activePath?: string;
  commentCounts: Readonly<Record<string, number>>;
  onPick: (path: string) => void;
}

export function GitReviewBrowser({ files, activePath, commentCounts, onPick }: GitReviewBrowserProps) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle === '' ? files : files.filter((file) => file.path.toLocaleLowerCase().includes(needle));
  const groups = needle === '' ? groupByDirectory(shown, (file) => file.path) : [{ prefix: '', items: [...shown] }];
  const ordered = groups.flatMap((group) => group.items);

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
        <span className="text-2xs text-doom-faint">
          {needle === ''
            ? `${String(files.length)} changed`
            : `${String(shown.length)} of ${String(files.length)} match`}
        </span>
      </div>
      <div data-git-review-list className="min-h-0 flex-1 overflow-y-auto pb-2">
        {groups.map((group) => (
          <div key={group.prefix === '' ? '(root)' : group.prefix}>
            {group.prefix === '' ? null : (
              <div className="truncate px-3 pt-2 pb-1 text-2xs font-bold tracking-wide text-doom-faint">
                {group.prefix}
              </div>
            )}
            {group.items.map((file) => {
              const mark = STATUS_MARK[file.status];
              const comments = commentCounts[file.path] ?? 0;
              const active = file.path === activePath;
              return (
                <Button
                  key={file.path}
                  variant="ghost"
                  size="card"
                  data-git-review-row
                  aria-current={active ? 'true' : undefined}
                  data-testid={`git-review-browser-file-${file.path}`}
                  title={`${file.path} (${mark.label})`}
                  onClick={() => onPick(file.path)}
                  onKeyDown={onKeyDown}
                  className={`min-w-0 flex-row items-center gap-1.5 rounded-none border-l-2 py-1.5 ${group.prefix === '' ? 'px-3' : 'pr-3 pl-5'} ${
                    active ? 'border-doom-blue bg-doom-panel' : 'border-transparent hover:bg-doom-panel/60'
                  }`}
                >
                  <span aria-label={mark.label} className={`w-2.5 shrink-0 text-2xs font-bold ${mark.tone}`}>
                    {mark.letter}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-bold text-doom-hi">
                    {groupRowLabel(group.prefix, file.path)}
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
          </div>
        ))}
        {ordered.length === 0 ? <p className="px-3 py-2 text-2xs text-doom-faint">no path matches</p> : null}
      </div>
    </nav>
  );
}
