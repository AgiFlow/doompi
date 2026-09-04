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
  describeAuthorToolsCallSummary,
  describeAuthorToolsCollapsedLines,
  describeAuthorToolsResultLines,
} from './describeAuthorToolsToolRender.ts';

/**
 * The describe_author_tools tool's timeline item: Describe the current Author viewport capabilities. The shell owns
 * the frame, the outcome tone, the status badge, and the expand toggle; this
 * card supplies the header summary and the body lines, and says whether it
 * hides any so the toggle appears only when it reveals something.
 */
export function DescribeAuthorToolsToolCard({ toolName, args, result, running, isError }: ToolMessageRenderProps) {
  const lines = describeAuthorToolsResultLines(result);
  const collapsed = collapseLines(lines, describeAuthorToolsCollapsedLines, false);
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={collapsed.hidden > 0}>
      {({ expanded }) => {
        const view = expanded ? collapseLines(lines, describeAuthorToolsCollapsedLines, true) : collapsed;
        return (
          <>
            <MessageItemHeader title={toolName}>
              <span data-testid={`tool-call-${toolName}`} className="min-w-0 flex-1 truncate text-doom-text">
                {describeAuthorToolsCallSummary(args)}
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
