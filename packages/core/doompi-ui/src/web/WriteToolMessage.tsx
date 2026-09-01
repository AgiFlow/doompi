import {
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { resultText, writeCallView } from './builtinToolView.ts';

/**
 * The write tool's timeline item: `path · N chars` in the header. Pi's write
 * result is silent on success, so the body shows the numbered preview the
 * TUI folds into its call: ten lines, or all of them once the item expands.
 * A failure shows the tool's message in red instead.
 */
export function WriteToolMessage({ args, result, output, running, isError }: ToolMessageRenderProps) {
  const collapsed = writeCallView(args, false);
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={collapsed.hidden > 0}>
      {({ expanded }) => {
        const view = expanded ? writeCallView(args, true) : collapsed;
        return (
          <>
            <MessageItemHeader title="write">
              <span data-testid="tool-call-write" className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-doom-text">{view.path}</span>
                <span className="shrink-0 text-doom-faint">· {view.size}</span>
              </span>
            </MessageItemHeader>
            {isError ? (
              <MessageItemBody data-testid="tool-result-write" className="flex flex-col">
                <MessageItemStatus tone="error">failed</MessageItemStatus>
                <span className="whitespace-pre-wrap break-words text-doom-red">{resultText(result, output)}</span>
              </MessageItemBody>
            ) : view.preview.length === 0 ? (
              running ? (
                <MessageItemBody data-testid="tool-result-write">
                  <MessageItemStatus tone="running">running</MessageItemStatus>
                </MessageItemBody>
              ) : null
            ) : (
              <MessageItemBody data-testid="tool-result-write" className="flex flex-col font-mono">
                {view.preview.map((line) => (
                  <span key={line.number} className="flex gap-2">
                    <span className="shrink-0 text-right text-doom-faint" style={{ width: `${String(view.gutter)}ch` }}>
                      {line.number}
                    </span>
                    <span className="min-w-0 whitespace-pre-wrap break-words text-doom-text">{line.text}</span>
                  </span>
                ))}
                {view.hidden > 0 ? <MessageItemStatus expands>{view.hidden} more lines</MessageItemStatus> : null}
                {running ? <MessageItemStatus tone="running">running</MessageItemStatus> : null}
              </MessageItemBody>
            )}
          </>
        );
      }}
    </MessageItem>
  );
}
