import {
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageLines,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { goalCallSummary, goalResultLines } from './goalToolRender.ts';

/**
 * The goal tools' timeline item: complete or blocked, with the summary or
 * reason the agent gave, in the header; the goal manager's outcome line,
 * with the full text once expanded, in the body.
 */
export function GoalToolMessage({ toolName, args, result, running, isError }: ToolMessageRenderProps) {
  const summary = goalCallSummary(toolName, args);
  const collapsed = goalResultLines(toolName, args, result, { expanded: false, isError, isPartial: running });
  const full = goalResultLines(toolName, args, result, { expanded: true, isError, isPartial: running });
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={full.length > collapsed.length}>
      {({ expanded }) => (
        <>
          <MessageItemHeader title={toolName}>
            <span data-testid={`tool-call-${toolName}`} className="flex min-w-0 flex-1 items-center gap-2">
              <span className="font-bold text-doom-hi">{summary.action}</span>
              {summary.detail ? <span className="min-w-0 truncate text-doom-faint">{summary.detail}</span> : null}
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
