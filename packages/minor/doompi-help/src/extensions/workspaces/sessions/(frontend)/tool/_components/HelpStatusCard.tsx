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

export function HelpStatusCard({ toolName, output, running, isError }: ToolMessageRenderProps) {
  const lines = output
    .split('\n')
    .filter(Boolean)
    .map((text) => ({ text, tone: 'text' as const }));
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={lines.length > 12}>
      {({ expanded }) => {
        const view = collapseLines(lines, 12, expanded);
        return (
          <>
            <MessageItemHeader title={toolName}>Help diagnostics</MessageItemHeader>
            <MessageItemBody>
              <MessageLines lines={view.shown} />
              {view.hidden > 0 ? <MessageItemStatus expands>{view.hidden} more lines</MessageItemStatus> : null}
              {running ? <MessageItemStatus tone="running">Inspecting this session</MessageItemStatus> : null}
              {isError ? <MessageItemStatus tone="error">Diagnostic unavailable</MessageItemStatus> : null}
            </MessageItemBody>
          </>
        );
      }}
    </MessageItem>
  );
}
