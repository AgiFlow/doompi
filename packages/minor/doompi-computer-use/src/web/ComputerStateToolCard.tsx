// @scaffold-generated
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
  computerStateCallSummary,
  computerStateCollapsedLines,
  computerStateResultLines,
} from './computerStateToolRender.ts';

/**
 * The computer_state tool's timeline item: Observe the authorized application window and semantic accessibility state. The shell owns
 * the frame, the outcome tone, the status badge, and the expand toggle; this
 * card supplies the header summary and the body lines, and says whether it
 * hides any so the toggle appears only when it reveals something.
 */
export function ComputerStateToolCard({ toolName, args, result, running, isError }: ToolMessageRenderProps) {
  const lines = computerStateResultLines(result);
  const collapsed = collapseLines(lines, computerStateCollapsedLines, false);
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={collapsed.hidden > 0}>
      {({ expanded }) => {
        const view = expanded ? collapseLines(lines, computerStateCollapsedLines, true) : collapsed;
        return (
          <>
            <MessageItemHeader title={toolName}>
              <span data-testid={`tool-call-${toolName}`} className="min-w-0 flex-1 truncate text-doom-text">
                {computerStateCallSummary(args)}
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
