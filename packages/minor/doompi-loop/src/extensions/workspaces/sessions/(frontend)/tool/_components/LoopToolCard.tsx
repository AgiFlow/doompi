import type { ToolMessageRenderProps } from '@agimon-ai/doompi-core/web';
import {
  collapseLines,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  MessageLines,
  toolTone,
} from '@agimon-ai/doompi-web-components';

/** Loop tools share the same compact, expandable result presentation. */
export function LoopToolCard({ toolName, result, running, isError }: ToolMessageRenderProps) {
  const lines =
    result === undefined
      ? []
      : JSON.stringify(result, null, 2)
          .split('\n')
          .map((text) => ({ text, tone: 'text' as const }));
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={lines.length > 8}>
      {({ expanded }) => {
        const view = collapseLines(lines, 8, expanded);
        return (
          <>
            <MessageItemHeader title={toolName} />
            <MessageItemBody>
              <MessageLines lines={view.shown} />
              {view.hidden > 0 ? <MessageItemStatus expands>{view.hidden} more lines</MessageItemStatus> : null}
              {running ? <MessageItemStatus tone="running">running</MessageItemStatus> : null}
              {isError ? <MessageItemStatus tone="error">failed</MessageItemStatus> : null}
            </MessageItemBody>
          </>
        );
      }}
    </MessageItem>
  );
}
