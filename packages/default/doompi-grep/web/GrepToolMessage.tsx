import {
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { grepCallView } from './grepToolView.ts';
import { HashlineLines } from './HashlineLines.tsx';
import { hashlineBody, resultTextLines } from './hashlineView.ts';

/**
 * The grep tool's timeline item, the web half of its renderCall and
 * renderResult: the call summary in the header and the anchored lines with
 * a line-number gutter in the body, collapsed to the TUI's budget until the
 * item expands. A failure shows the tool's message in red instead.
 */
export function GrepToolMessage({ args, result, output, running, isError }: ToolMessageRenderProps) {
  const view = grepCallView(args);
  const collapsed = result === null || isError ? null : hashlineBody(result, output, 'grep', false);
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={collapsed !== null && collapsed.hidden > 0}>
      {({ expanded }) => {
        const body =
          result === null || isError ? null : expanded ? hashlineBody(result, output, 'grep', true) : collapsed;
        return (
          <>
            <MessageItemHeader title="grep">
              <span data-testid="tool-call-grep" className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-doom-text">{view.pattern}</span>
                {view.details.length > 0 ? (
                  <span className="shrink-0 text-doom-faint">· {view.details.join(' · ')}</span>
                ) : null}
              </span>
            </MessageItemHeader>
            {isError ? (
              <MessageItemBody data-testid="tool-result-grep" className="flex flex-col">
                <MessageItemStatus tone="error">failed</MessageItemStatus>
                {resultTextLines(result, output).map((line, index) => (
                  <span key={`${String(index)}-${line}`} className="whitespace-pre-wrap break-words text-doom-red">
                    {line}
                  </span>
                ))}
              </MessageItemBody>
            ) : body === null ? (
              running ? (
                <MessageItemBody data-testid="tool-result-grep">
                  <MessageItemStatus tone="running">running</MessageItemStatus>
                </MessageItemBody>
              ) : null
            ) : body.shown.length === 0 && body.notice === undefined ? null : (
              <MessageItemBody data-testid="tool-result-grep" className="flex flex-col gap-1">
                <HashlineLines lines={body.shown} gutter={body.gutter} />
                {body.hidden > 0 ? <MessageItemStatus expands>{body.hidden} more lines</MessageItemStatus> : null}
                {body.notice !== undefined ? <span className="text-doom-faint">{body.notice}</span> : null}
              </MessageItemBody>
            )}
          </>
        );
      }}
    </MessageItem>
  );
}
