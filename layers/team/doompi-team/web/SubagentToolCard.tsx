import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { shapeResult, subagentCallDetail } from './toolText.ts';

/** The web half of renderSubagentCall: the action, then its per-action detail. */
export function SubagentCall({ args }: ToolCallRenderProps) {
  const action = typeof args.action === 'string' ? args.action : '';
  const detail = subagentCallDetail(args);
  return (
    <span data-testid="tool-call-subagent" className="flex min-w-0 items-center gap-2">
      <span className="text-doom-hi">{action}</span>
      {detail ? <span className="min-w-0 truncate text-doom-cyan">{detail}</span> : null}
    </span>
  );
}

const GLYPH_LINE = {
  running: { glyph: '◐', tone: 'text-doom-yellow', text: 'running' },
  failed: { glyph: '✗', tone: 'text-doom-red', text: 'failed' },
  done: { glyph: '✓', tone: 'text-doom-green', text: 'done' },
} as const;

/** The web half of renderSubagentResult: framed text lines with the closing glyph line. */
export function SubagentResult({ output, expanded, isPartial, isError }: ToolResultRenderProps) {
  const shaped = shapeResult(output, { expanded, isPartial, isError });
  const closing = shaped.glyph === 'none' || shaped.glyph === 'more' ? null : GLYPH_LINE[shaped.glyph];
  return (
    <div data-testid="tool-result-subagent" className="flex flex-col gap-1">
      {shaped.lines.length > 0 ? (
        <pre className={`${expanded ? 'whitespace-pre-wrap break-words' : 'truncate'} text-doom-dim`}>
          {shaped.lines.join('\n')}
        </pre>
      ) : null}
      {closing ? (
        <span className="text-doom-faint">
          <span className={closing.tone}>{closing.glyph}</span> {closing.text}
        </span>
      ) : null}
      {shaped.glyph === 'more' ? <span className="text-doom-faint">… {shaped.hidden} more line(s)</span> : null}
    </div>
  );
}
