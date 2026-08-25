import {
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  type StatusTone,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import {
  STATUS_LABEL,
  type TaskResultTone,
  type TaskRow,
  type TaskStatus,
  taskCallView,
  taskResultView,
} from './taskToolFormat.ts';

const STATUS_TONE: Record<TaskStatus, string> = {
  pending: 'text-doom-dim',
  in_progress: 'text-doom-yellow',
  completed: 'text-doom-green',
  failed: 'text-doom-red',
  deleted: 'text-doom-faint',
};

const RESULT_TONE: Record<TaskResultTone, StatusTone> = {
  running: 'running',
  ok: 'ok',
  error: 'error',
  warning: 'running',
};

/** One task row: status glyph, id, subject and chips on the left, the status label flushed right. */
function TaskRowLine({ row }: { row: TaskRow }) {
  return (
    <li data-testid="tool-result-task-row" data-task-id={row.id} className="flex items-baseline gap-2">
      <span className={`shrink-0 ${STATUS_TONE[row.status]}`}>{row.glyph}</span>
      <span className="shrink-0 text-doom-faint">#{row.id}</span>
      <span
        className={`min-w-0 flex-1 truncate ${row.closed ? 'text-doom-faint line-through' : row.status === 'in_progress' ? 'text-doom-blue' : 'text-doom-text'}`}
      >
        {row.subject}
        {row.agent ? <span className="text-doom-faint"> [{row.agent}]</span> : null}
        {row.activeForm ? <span className="text-doom-faint"> ({row.activeForm})</span> : null}
        {row.blockedBy.length > 0 ? (
          <span className="text-doom-faint"> ⛓ {row.blockedBy.map((id) => `#${id}`).join(',')}</span>
        ) : null}
      </span>
      <span className={`shrink-0 ${STATUS_TONE[row.status]}`}>{STATUS_LABEL[row.status]}</span>
    </li>
  );
}

/**
 * The task tool's timeline item: `glyph action subject` with the assignee or
 * list filter in the header, as renderTaskCall shows it; the rows the action
 * touched, then the batch or list summary, in the body, as renderTaskResult
 * lays it out.
 */
export function TaskToolMessage({ args, result, output, running, isError }: ToolMessageRenderProps) {
  const call = taskCallView(args);
  const collapsed = taskResultView({ details: result?.details, output, expanded: false, isPartial: running, isError });
  const full = taskResultView({ details: result?.details, output, expanded: true, isPartial: running, isError });
  const hidden = full.rows.length - collapsed.rows.length + (full.errorLines.length - collapsed.errorLines.length);
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={hidden > 0}>
      {({ expanded }) => {
        const view = expanded ? full : collapsed;
        const empty = view.rows.length === 0 && view.errorLines.length === 0 && view.status === null;
        return (
          <>
            <MessageItemHeader title="task">
              <span data-testid="tool-call-task" className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="shrink-0 text-doom-text">
                  {call.glyph} {call.action}
                </span>
                {call.subject ? (
                  <span
                    className={`min-w-0 truncate ${call.subjectTone === 'accent' ? 'text-doom-blue' : 'text-doom-dim'}`}
                  >
                    {call.subject}
                  </span>
                ) : null}
                {call.detail ? <span className="shrink-0 text-doom-faint">{call.detail}</span> : null}
              </span>
            </MessageItemHeader>
            {empty ? null : (
              <MessageItemBody data-testid="tool-result-task" className="flex flex-col gap-1">
                {view.rows.length > 0 ? (
                  <ul className="flex flex-col gap-0.5">
                    {view.rows.map((row) => (
                      <TaskRowLine key={row.id} row={row} />
                    ))}
                  </ul>
                ) : null}
                {view.errorLines.length > 0 ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-doom-dim">
                    {view.errorLines.join('\n')}
                  </pre>
                ) : null}
                {!expanded && hidden > 0 ? <MessageItemStatus expands>{hidden} more</MessageItemStatus> : null}
                {view.status ? (
                  <MessageItemStatus
                    data-testid="tool-result-task-status"
                    tone={RESULT_TONE[view.status.tone]}
                    glyph={view.status.glyph}
                  >
                    {view.status.text}
                  </MessageItemStatus>
                ) : null}
              </MessageItemBody>
            )}
          </>
        );
      }}
    </MessageItem>
  );
}
