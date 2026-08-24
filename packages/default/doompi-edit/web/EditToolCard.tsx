import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { editCallView, editResultView, resultTextLines, type DiffRow } from './editToolView.ts';

/** The cockpit's half of the edit tool's renderCall: `path · N ranges`. */
export function EditToolCall({ args }: ToolCallRenderProps) {
  const view = editCallView(args);
  return (
    <span data-testid="tool-call-edit" className="flex min-w-0 items-center gap-2">
      <span className="truncate text-doom-text">{view.path}</span>
      <span className="shrink-0 text-doom-faint">· {view.ranges}</span>
    </span>
  );
}

// Doom carries a diff on the background the way Magit does: a green wash on
// added rows, a red wash on removed ones, and the foreground left to the text.
const ROW_TONE: Readonly<Record<DiffRow['marker'], string>> = {
  '+': 'bg-[#262E1E] text-doom-green',
  '-': 'bg-[#332428] text-doom-red',
  ' ': 'text-doom-dim',
};

/**
 * The edit tool's renderResult: the display diff from the result's details,
 * banded by row. A successful edit whose details never arrived shows nothing,
 * and a failed one shows the tool's message in red.
 */
export function EditToolResult({ result, output, isPartial, isError, expanded }: ToolResultRenderProps) {
  if (isError) {
    const lines = resultTextLines(result, output);
    return (
      <div data-testid="tool-result-edit" className="flex flex-col">
        <span className="text-doom-red">✗ failed</span>
        {lines.map((line, index) => (
          <span key={index} className="whitespace-pre-wrap break-words text-doom-red">
            {line}
          </span>
        ))}
      </div>
    );
  }
  if (result === null) {
    return isPartial ? (
      <span data-testid="tool-result-edit" className="text-doom-yellow">
        ◐ running
      </span>
    ) : null;
  }
  const view = editResultView(result);
  if (view === undefined) return null;
  return (
    <div
      data-testid="tool-result-edit"
      className={`flex flex-col font-mono ${expanded ? '' : 'max-h-[360px] overflow-y-auto'}`}
    >
      {view.rows.map((row, index) => (
        <span key={index} className={`flex gap-2 ${ROW_TONE[row.marker]}`}>
          <span className="shrink-0 text-right text-doom-faint" style={{ width: `${view.gutter}ch` }}>
            {row.lineNumber}
          </span>
          <span className="w-2 shrink-0">{row.marker === ' ' ? '' : row.marker}</span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{row.content}</span>
        </span>
      ))}
    </div>
  );
}
