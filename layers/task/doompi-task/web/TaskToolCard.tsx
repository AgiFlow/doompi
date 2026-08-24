import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
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

const RESULT_TONE: Record<TaskResultTone, string> = {
  running: 'text-doom-yellow',
  ok: 'text-doom-green',
  error: 'text-doom-red',
  warning: 'text-doom-yellow',
};

/** The call half: `glyph action subject`, with the assignee or list filter, as renderTaskCall shows it. */
export function TaskCall({ args }: ToolCallRenderProps) {
  const view = taskCallView(args);
  return (
    <span data-testid="tool-call-task" className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="shrink-0 rounded-[3px] bg-doom-border-soft px-1 text-[9px] font-bold uppercase text-doom-dim">
        task
      </span>
      <span className="shrink-0 text-doom-text">
        {view.glyph} {view.action}
      </span>
      {view.subject ? (
        <span className={`min-w-0 truncate ${view.subjectTone === 'accent' ? 'text-doom-blue' : 'text-doom-dim'}`}>
          {view.subject}
        </span>
      ) : null}
      {view.detail ? <span className="shrink-0 text-doom-faint">{view.detail}</span> : null}
    </span>
  );
}

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

/** The result half: the rows the action touched, then the batch or list summary, as renderTaskResult lays it out. */
export function TaskResult({ result, output, expanded, isPartial, isError }: ToolResultRenderProps) {
  const view = taskResultView({ details: result?.details, output, expanded, isPartial, isError });
  if (view.rows.length === 0 && view.errorLines.length === 0 && view.status === null) return null;
  return (
    <div data-testid="tool-result-task" className="flex flex-col gap-1">
      {view.rows.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {view.rows.map((row) => (
            <TaskRowLine key={row.id} row={row} />
          ))}
        </ul>
      ) : null}
      {view.errorLines.length > 0 ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-doom-dim">{view.errorLines.join('\n')}</pre>
      ) : null}
      {view.status ? (
        <span data-testid="tool-result-task-status" className="flex items-center gap-1.5 text-doom-faint">
          <span className={RESULT_TONE[view.status.tone]}>{view.status.glyph}</span>
          {view.status.text ? <span>{view.status.text}</span> : null}
        </span>
      ) : null}
    </div>
  );
}
