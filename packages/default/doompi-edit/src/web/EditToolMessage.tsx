import {
  collapseLines,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  SyntaxLine,
  toolTone,
  useSyntaxLines,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { type DiffRow, editCallView, editResultView, resultTextLines } from './editToolView.ts';

/** Diff rows shown until the item expands; about what the old scroll box held. */
const COLLAPSED_ROWS = 24;

// Doom carries a diff on the background the way Magit does: a green wash on
// added rows, a red wash on removed ones, and the foreground left to the text.
const ROW_TONE: Readonly<Record<DiffRow['marker'], string>> = {
  '+': 'bg-doom-tint-green text-doom-green',
  '-': 'bg-doom-tint-red text-doom-red',
  ' ': 'text-doom-dim',
};

/**
 * The banded rows, and the grammar over them.
 *
 * Its own component because the colours come from a hook, and the body that
 * renders these rows is chosen inside a render prop. The rows are parsed as
 * one document: a diff is not a file, so a replaced line is seen twice and a
 * split string can colour oddly, which costs a token here and there and never
 * costs the reader the text. The `+` and `-` wash stays underneath, so what
 * changed is still legible when the grammar has coloured the foreground.
 */
function DiffRows({ rows, gutter, path }: { rows: readonly DiffRow[]; gutter: number; path: string }) {
  const spans = useSyntaxLines(rows.map((row) => row.content).join('\n'), { path });
  return (
    <>
      {rows.map((row, index) => (
        <span key={`${String(index)}-${row.lineNumber}`} className={`flex gap-2 ${ROW_TONE[row.marker]}`}>
          <span className="shrink-0 text-right text-doom-faint" style={{ width: `${String(gutter)}ch` }}>
            {row.lineNumber}
          </span>
          <span className="w-2 shrink-0">{row.marker === ' ' ? '' : row.marker}</span>
          <SyntaxLine spans={spans?.[index]} text={row.content} className="min-w-0 whitespace-pre-wrap break-words" />
        </span>
      ))}
    </>
  );
}

/**
 * The edit tool's timeline item: `path · N ranges` in the header; the display
 * diff from the result's details, banded by row, in the body. A successful
 * edit whose details never arrived shows nothing, and a failed one shows the
 * tool's message in red.
 */
export function EditToolMessage({ args, result, output, running, isError }: ToolMessageRenderProps) {
  const call = editCallView(args);
  const view = result === null || isError ? undefined : editResultView(result);
  return (
    <MessageItem
      tone={toolTone({ running, isError })}
      expandable={view !== undefined && view.rows.length > COLLAPSED_ROWS}
    >
      {({ expanded }) => (
        <>
          <MessageItemHeader title="edit">
            <span data-testid="tool-call-edit" className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-doom-text">{call.path}</span>
              <span className="shrink-0 text-doom-faint">· {call.ranges}</span>
            </span>
          </MessageItemHeader>
          {isError ? (
            <MessageItemBody data-testid="tool-result-edit" className="flex flex-col">
              <MessageItemStatus tone="error">failed</MessageItemStatus>
              {resultTextLines(result, output).map((line, index) => (
                <span key={`${String(index)}-${line}`} className="whitespace-pre-wrap break-words text-doom-red">
                  {line}
                </span>
              ))}
            </MessageItemBody>
          ) : view === undefined ? (
            running ? (
              <MessageItemBody data-testid="tool-result-edit">
                <MessageItemStatus tone="running">running</MessageItemStatus>
              </MessageItemBody>
            ) : null
          ) : (
            (() => {
              const { shown, hidden } = collapseLines(view.rows, COLLAPSED_ROWS, expanded);
              return (
                <MessageItemBody data-testid="tool-result-edit" className="flex flex-col font-mono">
                  <DiffRows rows={shown} gutter={view.gutter} path={call.path} />
                  {hidden > 0 ? (
                    <MessageItemStatus expands className="pt-1">
                      {hidden} more rows
                    </MessageItemStatus>
                  ) : null}
                </MessageItemBody>
              );
            })()
          )}
        </>
      )}
    </MessageItem>
  );
}
