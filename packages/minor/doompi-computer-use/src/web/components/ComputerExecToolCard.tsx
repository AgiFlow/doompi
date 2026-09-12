import {
  collapseLines,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  MessageLines,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import {
  computerExecCallSummary,
  computerExecCollapsedLines,
  computerExecResultLines,
} from '../lib/computerExecToolRender';

export function ComputerExecToolCard({ toolName, args, result, running, isError }: ToolMessageRenderProps) {
  const lines = computerExecResultLines(result);
  const collapsed = collapseLines(lines, computerExecCollapsedLines, false);
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={collapsed.hidden > 0}>
      {({ expanded }) => {
        const view = expanded ? collapseLines(lines, computerExecCollapsedLines, true) : collapsed;
        return (
          <>
            <MessageItemHeader title={toolName}>
              <span data-testid={`tool-call-${toolName}`} className="min-w-0 flex-1 truncate text-doom-text">
                {computerExecCallSummary(args)}
              </span>
            </MessageItemHeader>
            {view.shown.length > 0 || running || isError ? (
              <MessageItemBody data-testid={`tool-result-${toolName}`} className="flex flex-col gap-1">
                {view.shown.length > 0 ? <MessageLines lines={view.shown} /> : null}
                {view.hidden > 0 ? <MessageItemStatus expands>{view.hidden} more line(s)</MessageItemStatus> : null}
                {running ? <MessageItemStatus tone="running">running</MessageItemStatus> : null}
                {isError ? <MessageItemStatus tone="error">failed</MessageItemStatus> : null}
              </MessageItemBody>
            ) : null}
          </>
        );
      }}
    </MessageItem>
  );
}
