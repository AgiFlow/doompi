import type { ToolMessageRenderProps } from '@agimon-ai/doompi-core/web';
import {
  Button,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  type StatusTone,
  toolTone,
} from '@agimon-ai/doompi-web-components';

import { subagentsTab } from '../../_components/SubagentsPanel';
import {
  COLLAPSED_RESULT_ROWS,
  shapeResult,
  subagentCallDetail,
  subagentResultView,
  type SubagentRow,
  type SubagentRowTone,
} from '../_lib/toolText';

const CLOSING = {
  running: { tone: 'running', text: 'running' },
  failed: { tone: 'error', text: 'failed' },
  done: { tone: 'ok', text: 'done' },
} as const;

const ROW_TONE: Record<SubagentRowTone, string> = {
  ok: 'text-doom-green',
  error: 'text-doom-red',
  running: 'text-doom-yellow',
  idle: 'text-doom-dim',
};

const STATUS_TONE: Record<SubagentRowTone, StatusTone> = {
  ok: 'ok',
  error: 'error',
  running: 'running',
  idle: 'ok',
};

/** One structured row: the run or agent, what it is doing, and its state flushed right. */
function SubagentRowLine({ row }: { row: SubagentRow }) {
  return (
    <li data-testid="tool-result-subagent-row" className="flex items-baseline gap-2">
      <span className="shrink-0 text-doom-cyan">{row.label}</span>
      <span className="min-w-0 flex-1 truncate text-doom-dim">{row.detail}</span>
      {row.state ? <span className={`shrink-0 ${ROW_TONE[row.tone]}`}>{row.state}</span> : null}
    </li>
  );
}

/**
 * The subagent tool's timeline item, the web half of renderSubagentCall and
 * renderSubagentResult: the action and its per-action detail in the header,
 * the rows the result reported in the body, and the subagents tab one click
 * away. A result the narrower does not recognise, a partial one included,
 * falls back to the text the model was given.
 */
export function SubagentToolMessage({
  args,
  result,
  output,
  running,
  isError,
  openTransientTab,
}: ToolMessageRenderProps) {
  const action = typeof args.action === 'string' ? args.action : '';
  const detail = subagentCallDetail(args);
  const view = running || isError ? null : subagentResultView(result?.details);
  const hiddenRows = view ? Math.max(0, view.rows.length - COLLAPSED_RESULT_ROWS) : 0;
  const collapsedText = view ? null : shapeResult(output, { expanded: false, isPartial: running, isError });
  return (
    <MessageItem
      tone={toolTone({ running, isError })}
      expandable={view ? hiddenRows > 0 : collapsedText?.glyph === 'more'}
    >
      {({ expanded }) => {
        const shaped =
          view || !collapsedText
            ? null
            : expanded
              ? shapeResult(output, { expanded: true, isPartial: running, isError })
              : collapsedText;
        const closing = !shaped || shaped.glyph === 'none' || shaped.glyph === 'more' ? null : CLOSING[shaped.glyph];
        const rows = view ? (expanded ? view.rows : view.rows.slice(0, COLLAPSED_RESULT_ROWS)) : [];
        return (
          <>
            <MessageItemHeader title="subagent">
              <span data-testid="tool-call-subagent" className="flex min-w-0 flex-1 items-center gap-2">
                <span className="text-doom-hi">{action}</span>
                {detail ? <span className="min-w-0 truncate text-doom-cyan">{detail}</span> : null}
              </span>
            </MessageItemHeader>
            <MessageItemBody data-testid="tool-result-subagent" className="flex flex-col gap-1">
              {rows.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {rows.map((row) => (
                    <SubagentRowLine key={row.key} row={row} />
                  ))}
                </ul>
              ) : null}
              {shaped && shaped.lines.length > 0 ? (
                <pre className={`${expanded ? 'whitespace-pre-wrap break-words' : 'truncate'} text-doom-dim`}>
                  {shaped.lines.join('\n')}
                </pre>
              ) : null}
              {!expanded && hiddenRows > 0 ? <MessageItemStatus expands>{hiddenRows} more</MessageItemStatus> : null}
              {view && view.summary ? (
                <MessageItemStatus data-testid="tool-result-subagent-summary" tone={STATUS_TONE[view.tone]}>
                  {view.summary}
                </MessageItemStatus>
              ) : null}
              {closing ? <MessageItemStatus tone={closing.tone}>{closing.text}</MessageItemStatus> : null}
              {shaped?.glyph === 'more' ? (
                <MessageItemStatus expands>{shaped.hidden} more line(s)</MessageItemStatus>
              ) : null}
              <Button
                variant="link"
                size="xs"
                data-testid="tool-result-subagent-open"
                onClick={() => openTransientTab(subagentsTab())}
                className="self-start px-0"
              >
                open subagents
              </Button>
            </MessageItemBody>
          </>
        );
      }}
    </MessageItem>
  );
}
