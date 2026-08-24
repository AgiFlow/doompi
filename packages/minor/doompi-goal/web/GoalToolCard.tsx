import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { goalCallSummary, goalResultLines, type LineTone } from './goalToolRender.ts';

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

/** The call half: complete or blocked, with the summary or reason the agent gave. */
export function GoalCall({ toolName, args }: ToolCallRenderProps) {
  const summary = goalCallSummary(toolName, args);
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

/** The result half: the goal manager's outcome line, with the full text once expanded. */
export function GoalResult({ toolName, args, result, expanded, isError, isPartial }: ToolResultRenderProps) {
  const lines = goalResultLines(toolName, args, result, { expanded, isError, isPartial });
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
