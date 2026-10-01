import { Fragment, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { diffGutterWidth, diffRangeOf } from '../lib/review';
import type { DiffHunk, DiffMarker, DiffRow, DiffSelection } from '../types/diff';
import { Button } from './Button';

/**
 * A diff, drawn the way this cockpit draws every other one: a numbered gutter
 * and a background wash per row, so a change reads at a glance rather than by
 * hunting for leading punctuation.
 *
 * Hunks arrive apart rather than joined by an elision marker, so the gap
 * between two of them is a rule the component draws, not a line it has to
 * recognise in a string.
 *
 * A reader comments two ways: by highlighting text, which reports the lines the
 * highlight touches, or by clicking a line number, which reports that one line.
 * Either way the selection names its side, so a note on a removed line points
 * at the old file rather than at whatever the new file has on that number.
 */

const ROW_TONE: Readonly<Record<DiffMarker, string>> = {
  '+': 'bg-doom-tint-green text-doom-green',
  '-': 'bg-doom-tint-red text-doom-red',
  ' ': 'text-doom-dim',
};

export interface DiffViewProps {
  hunks: readonly DiffHunk[];
  /** Marks the surface so a test and a selection handler can find it. Unique per diff on a page. */
  testId: string;
  /** Called with the selected text, the lines it covers, and their side. Enables line-number clicks. */
  onSelect?: (selection: DiffSelection) => void;
  /** Drawn under one row, full width: inline comments and an open draft go here. */
  renderAfterRow?: (row: DiffRow) => ReactNode;
  className?: string;
}

function isMarker(value: string | undefined): value is DiffMarker {
  return value === '+' || value === '-' || value === ' ';
}

export function DiffView({ hunks, testId, onSelect, renderAfterRow, className }: DiffViewProps) {
  const gutter = diffGutterWidth(hunks);

  /**
   * Turns whatever the reader highlighted into a line range. The rows carry
   * their own numbers and markers, so the range comes from the rows the
   * selection touches rather than from counting newlines in the rendered text.
   */
  const handleSelect = (): void => {
    if (onSelect === undefined) return;
    const selection = globalThis.getSelection?.();
    const text = selection?.toString() ?? '';
    if (text.trim() === '') return;
    const rows = [...document.querySelectorAll<HTMLElement>(`[data-diff-surface="${testId}"] [data-diff-line]`)];
    const touched = rows
      .filter((row) => selection?.containsNode(row, true) === true)
      .map((row) => ({ marker: row.dataset.diffMarker, line: Number(row.dataset.diffLine) }))
      .filter((row): row is { marker: DiffMarker; line: number } => isMarker(row.marker));
    const range = diffRangeOf(touched);
    if (range !== undefined) onSelect({ ...range, snippet: text });
  };

  if (hunks.length === 0) {
    return (
      <p data-testid={`${testId}-empty`} className="px-2 py-1 text-xs text-doom-faint">
        no lines changed
      </p>
    );
  }

  return (
    <div
      data-testid={testId}
      data-diff-surface={testId}
      onMouseUp={handleSelect}
      className={cn('overflow-x-auto font-mono text-sm leading-normal', className)}
    >
      {hunks.map((hunk, position) => (
        <div key={`${hunk.start}-${position}`}>
          {position > 0 ? (
            <div className="flex items-center gap-2 px-2 py-0.5 text-2xs text-doom-faint">
              <span className="h-px flex-1 bg-doom-border-soft" />
              <span>⋯</span>
              <span className="h-px flex-1 bg-doom-border-soft" />
            </div>
          ) : null}
          {hunk.rows.map((row, offset) => (
            <Fragment key={`${row.marker}-${row.line}-${offset}`}>
              <div
                data-diff-line={row.line}
                data-diff-marker={row.marker}
                className={cn('flex whitespace-pre', ROW_TONE[row.marker])}
              >
                {onSelect === undefined ? (
                  <span
                    aria-hidden
                    className="shrink-0 select-none pr-2 pl-2 text-right text-doom-faint"
                    style={{ width: `${gutter + 2}ch` }}
                  >
                    {row.line}
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    data-diff-gutter={row.line}
                    aria-label={`comment on ${row.marker === '-' ? 'removed ' : ''}line ${row.line}`}
                    onClick={() =>
                      onSelect({
                        side: row.marker === '-' ? 'old' : 'new',
                        startLine: row.line,
                        endLine: row.line,
                        snippet: row.content,
                      })
                    }
                    className="h-auto min-h-0 min-w-0 shrink-0 select-none justify-end rounded-none py-0 pr-2 pl-2 font-normal text-sm text-doom-faint hover:bg-transparent hover:text-doom-blue"
                    style={{ width: `${gutter + 2}ch` }}
                  >
                    {row.line}
                  </Button>
                )}
                <span className="shrink-0 select-none pr-1">{row.marker}</span>
                <span className="min-w-0">{row.content}</span>
              </div>
              {renderAfterRow?.(row)}
            </Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}
