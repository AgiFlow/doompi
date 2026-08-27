import type { FileEditsDiffHunk } from '../src/types/fileEditsApi.ts';
import { gutterWidth } from './fileView.ts';

/**
 * A diff, drawn the way this cockpit draws every other one: a numbered gutter
 * and a background wash per row, so a change reads at a glance rather than by
 * hunting for leading punctuation.
 *
 * Hunks arrive apart rather than joined by an elision marker, so the gap
 * between two of them is a rule the component draws, not a line it has to
 * recognise in a string.
 */

const ROW_TONE: Readonly<Record<string, string>> = {
  '+': 'bg-doom-tint-green text-doom-green',
  '-': 'bg-doom-tint-red text-doom-red',
  ' ': 'text-doom-dim',
};

export interface DiffViewProps {
  hunks: readonly FileEditsDiffHunk[];
  /** Marks the surface so a test and a selection handler can find it. */
  testId: string;
  /** Called with the selected text and the lines it covers. */
  onSelect?: (selection: { startLine: number; endLine: number; snippet: string }) => void;
}

export function DiffView({ hunks, testId, onSelect }: DiffViewProps) {
  const gutter = gutterWidth(hunks);

  /**
   * Turns whatever the reader highlighted into a line range. The rows carry
   * their own numbers, so the range comes from the first and last row the
   * selection touches rather than from counting newlines in the rendered text.
   */
  const handleSelect = (): void => {
    if (onSelect === undefined) return;
    const selection = globalThis.getSelection?.();
    const text = selection?.toString() ?? '';
    if (text.trim() === '') return;
    const rows = [...document.querySelectorAll<HTMLElement>(`[data-diff-surface="${testId}"] [data-diff-line]`)];
    const touched = rows.filter((row) => selection?.containsNode(row, true) === true);
    const numbers = touched
      .map((row) => Number(row.dataset.diffLine))
      .filter((line) => Number.isFinite(line) && line > 0);
    if (numbers.length === 0) return;
    onSelect({ startLine: Math.min(...numbers), endLine: Math.max(...numbers), snippet: text });
  };

  if (hunks.length === 0) {
    return (
      <p data-testid={`${testId}-empty`} className="px-2 py-1 text-[10px] text-doom-faint">
        no lines changed
      </p>
    );
  }

  return (
    <div
      data-testid={testId}
      data-diff-surface={testId}
      onMouseUp={handleSelect}
      className="overflow-x-auto font-mono text-[11px] leading-[1.5]"
    >
      {hunks.map((hunk, position) => (
        <div key={`${hunk.start}-${position}`}>
          {position > 0 ? (
            <div className="flex items-center gap-2 px-2 py-0.5 text-[9px] text-doom-faint">
              <span className="h-px flex-1 bg-doom-border-soft" />
              <span>⋯</span>
              <span className="h-px flex-1 bg-doom-border-soft" />
            </div>
          ) : null}
          {hunk.rows.map((row, offset) => (
            <div
              key={`${row.marker}-${row.line}-${offset}`}
              data-diff-line={row.line}
              data-diff-marker={row.marker}
              className={`flex whitespace-pre ${ROW_TONE[row.marker] ?? 'text-doom-dim'}`}
            >
              <span
                aria-hidden
                className="shrink-0 select-none pr-2 pl-2 text-right text-doom-faint"
                style={{ width: `${gutter + 2}ch` }}
              >
                {row.line}
              </span>
              <span className="shrink-0 select-none pr-1">{row.marker}</span>
              <span className="min-w-0">{row.content}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
