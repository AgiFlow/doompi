import {
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { intercomCallSummary, intercomOutcome, shapeResult } from './toolText.ts';

const OUTCOME_LINE = {
  delivered: { tone: 'ok', text: 'delivered to' },
  queued: { tone: 'running', text: 'queued, delivery unconfirmed, for' },
  replied: { tone: 'ok', text: 'replied to' },
  answered: { tone: 'ok', text: 'answered by' },
} as const;

/**
 * The intercom tool's timeline item. Intercom has no TUI renderer; the
 * header names the action, its member or request, and the message, and the
 * body shows the result text with the outcome the details report.
 */
export function IntercomToolMessage({ args, result, output, running, isError }: ToolMessageRenderProps) {
  const summary = intercomCallSummary(args);
  const collapsed = shapeResult(output, { expanded: false, isPartial: running, isError });
  const outcome = running || isError ? { outcome: 'none' as const, who: '' } : intercomOutcome(result?.details);
  const line = outcome.outcome === 'none' ? null : OUTCOME_LINE[outcome.outcome];
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={collapsed.glyph === 'more'}>
      {({ expanded }) => {
        const shaped = expanded ? shapeResult(output, { expanded: true, isPartial: running, isError }) : collapsed;
        return (
          <>
            <MessageItemHeader title="intercom">
              <span data-testid="tool-call-intercom" className="flex min-w-0 flex-1 items-center gap-2">
                <span className="text-doom-hi">{summary.action}</span>
                {summary.target ? <span className="shrink-0 text-doom-cyan">→ {summary.target}</span> : null}
                {summary.message ? <span className="min-w-0 truncate text-doom-dim">{summary.message}</span> : null}
              </span>
            </MessageItemHeader>
            <MessageItemBody data-testid="tool-result-intercom" className="flex flex-col gap-1">
              {shaped.lines.length > 0 ? (
                <pre className={`${expanded ? 'whitespace-pre-wrap break-words' : 'truncate'} text-doom-dim`}>
                  {shaped.lines.join('\n')}
                </pre>
              ) : null}
              {running ? <MessageItemStatus tone="running">waiting</MessageItemStatus> : null}
              {isError ? <MessageItemStatus tone="error">failed</MessageItemStatus> : null}
              {line ? (
                <MessageItemStatus tone={line.tone}>
                  {line.text} <span className="text-doom-cyan">{outcome.who}</span>
                </MessageItemStatus>
              ) : null}
              {shaped.glyph === 'more' ? (
                <MessageItemStatus expands>{shaped.hidden} more line(s)</MessageItemStatus>
              ) : null}
            </MessageItemBody>
          </>
        );
      }}
    </MessageItem>
  );
}
