import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { intercomCallSummary, intercomOutcome, shapeResult } from './toolText.ts';

/** Intercom has no TUI renderer; the header names the action, its member or request, and the message. */
export function IntercomCall({ args }: ToolCallRenderProps) {
  const summary = intercomCallSummary(args);
  return (
    <span data-testid="tool-call-intercom" className="flex min-w-0 items-center gap-2">
      <span className="text-doom-hi">{summary.action}</span>
      {summary.target ? <span className="shrink-0 text-doom-cyan">→ {summary.target}</span> : null}
      {summary.message ? <span className="min-w-0 truncate text-doom-dim">{summary.message}</span> : null}
    </span>
  );
}

const OUTCOME_LINE = {
  delivered: { glyph: '✓', tone: 'text-doom-green', text: 'delivered to' },
  queued: { glyph: '◐', tone: 'text-doom-yellow', text: 'queued, delivery unconfirmed, for' },
  replied: { glyph: '✓', tone: 'text-doom-green', text: 'replied to' },
  answered: { glyph: '✓', tone: 'text-doom-green', text: 'answered by' },
} as const;

/** The result text (member list, pending asks, the reply) with the outcome the details report. */
export function IntercomResult({ output, result, expanded, isPartial, isError }: ToolResultRenderProps) {
  const shaped = shapeResult(output, { expanded, isPartial, isError });
  const outcome = isPartial || isError ? { outcome: 'none' as const, who: '' } : intercomOutcome(result?.details);
  const line = outcome.outcome === 'none' ? null : OUTCOME_LINE[outcome.outcome];
  return (
    <div data-testid="tool-result-intercom" className="flex flex-col gap-1">
      {shaped.lines.length > 0 ? (
        <pre className={`${expanded ? 'whitespace-pre-wrap break-words' : 'truncate'} text-doom-dim`}>
          {shaped.lines.join('\n')}
        </pre>
      ) : null}
      {isPartial ? (
        <span className="text-doom-faint">
          <span className="text-doom-yellow">◐</span> waiting
        </span>
      ) : null}
      {isError ? (
        <span className="text-doom-faint">
          <span className="text-doom-red">✗</span> failed
        </span>
      ) : null}
      {line ? (
        <span className="text-doom-faint">
          <span className={line.tone}>{line.glyph}</span> {line.text}{' '}
          <span className="text-doom-cyan">{outcome.who}</span>
        </span>
      ) : null}
      {shaped.glyph === 'more' ? <span className="text-doom-faint">… {shaped.hidden} more line(s)</span> : null}
    </div>
  );
}
