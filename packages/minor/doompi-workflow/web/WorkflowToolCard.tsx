import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import {
  type LineTone,
  type WorkflowToolName,
  WORKFLOW_TOOL_NAMES,
  workflowCallSummary,
  workflowResultLines,
} from './workflowToolRender.ts';

// The TUI's theme colors mapped onto the cockpit's tokens.
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

function workflowToolName(name: string): WorkflowToolName {
  return WORKFLOW_TOOL_NAMES.includes(name as WorkflowToolName) ? (name as WorkflowToolName) : 'workflow_run';
}

/** The call half: `action · target · flags`, the web analog of renderWorkflowToolCall. */
export function WorkflowCall({ toolName, args }: ToolCallRenderProps) {
  const summary = workflowCallSummary(workflowToolName(toolName), args);
  return (
    <span data-testid={`tool-call-${toolName}`} className="flex min-w-0 items-center gap-2">
      <span className="font-bold text-doom-hi">{summary.action}</span>
      {summary.target ? <span className="min-w-0 truncate text-doom-faint">{summary.target}</span> : null}
      {summary.metadata.map((value) => (
        <span key={value} className="shrink-0 text-doom-dim">
          · {value}
        </span>
      ))}
    </span>
  );
}

/** The result half: the shape-specific summary lines of renderWorkflowToolResult. */
export function WorkflowResult({ toolName, args, result, expanded, isError, isPartial }: ToolResultRenderProps) {
  const lines = workflowResultLines(workflowToolName(toolName), args, result, { expanded, isError, isPartial });
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
