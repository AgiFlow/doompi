import {
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageLines,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import {
  type WorkflowToolName,
  WORKFLOW_TOOL_NAMES,
  workflowCallSummary,
  workflowResultLines,
} from './workflowToolRender.ts';

function workflowToolName(name: string): WorkflowToolName {
  return WORKFLOW_TOOL_NAMES.includes(name as WorkflowToolName) ? (name as WorkflowToolName) : 'workflow_run';
}

/**
 * The workflow tools' timeline item, the web analog of renderWorkflowToolCall
 * and renderWorkflowToolResult: `action · target · flags` in the header and
 * the shape-specific summary lines in the body.
 */
export function WorkflowToolMessage({ toolName, args, result, running, isError }: ToolMessageRenderProps) {
  const name = workflowToolName(toolName);
  const summary = workflowCallSummary(name, args);
  const collapsed = workflowResultLines(name, args, result, { expanded: false, isError, isPartial: running });
  const full = workflowResultLines(name, args, result, { expanded: true, isError, isPartial: running });
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={full.length > collapsed.length}>
      {({ expanded }) => (
        <>
          <MessageItemHeader title={toolName}>
            <span data-testid={`tool-call-${toolName}`} className="flex min-w-0 flex-1 items-center gap-2">
              <span className="font-bold text-doom-hi">{summary.action}</span>
              {summary.target ? <span className="min-w-0 truncate text-doom-faint">{summary.target}</span> : null}
              {summary.metadata.map((value) => (
                <span key={value} className="shrink-0 text-doom-dim">
                  · {value}
                </span>
              ))}
            </span>
          </MessageItemHeader>
          {(expanded ? full : collapsed).length > 0 ? (
            <MessageItemBody data-testid={`tool-result-${toolName}`}>
              <MessageLines lines={expanded ? full : collapsed} />
            </MessageItemBody>
          ) : null}
        </>
      )}
    </MessageItem>
  );
}
