import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { type LineTone, planCallSummary, planResultLines } from './planToolRender.ts';

const TONE: Record<LineTone, string> = {
  hi: 'text-doom-hi',
  text: 'text-doom-text',
  dim: 'text-doom-dim',
  muted: 'text-doom-faint',
  success: 'text-doom-green',
  error: 'text-doom-red',
  warning: 'text-doom-yellow',
  accent: 'text-doom-blue',
};

/** The call half: the plan action, the issue or decision it targets, and what the packet carries. */
export function PlanCall({ toolName, args }: ToolCallRenderProps) {
  const summary = planCallSummary(toolName, args);
  return (
    <span data-testid={`tool-call-${toolName}`} className="flex min-w-0 items-center gap-2">
      <span className="font-bold text-doom-hi">{summary.action}</span>
      {summary.detail ? <span className="min-w-0 truncate text-doom-faint">{summary.detail}</span> : null}
      {summary.metadata.map((value) => (
        <span key={value} className="shrink-0 text-doom-dim">
          · {value}
        </span>
      ))}
    </span>
  );
}

/** The result half: the outcome line, with the recorded evidence or the Fable draft once expanded. */
export function PlanResult({ toolName, args, result, expanded, isError, isPartial }: ToolResultRenderProps) {
  const lines = planResultLines(toolName, args, result, { expanded, isError, isPartial });
  return (
    <div data-testid={`tool-result-${toolName}`} className="flex flex-col gap-0.5">
      {lines.map((entry, index) => (
        <div
          key={`${index}-${entry.text}`}
          className={`whitespace-pre-wrap break-words ${TONE[entry.tone]} ${entry.bold ? 'font-bold' : ''} ${
            entry.indent ? 'pl-4' : ''
          }`}
        >
          {entry.text}
        </div>
      ))}
    </div>
  );
}
