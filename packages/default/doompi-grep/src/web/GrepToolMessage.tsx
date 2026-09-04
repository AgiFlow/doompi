import {
  HashlineLines,
  hashlineBody,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  resultTextLines,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { grepCallView } from './grepToolView.ts';

/**
 * The grep tool's timeline item, the web half of its renderCall and
 * renderResult: the call summary in the header and, when expanded, the
 * anchored matches with a line-number gutter in the body. A failure shows the
 * tool's message in red inside the expanded body instead.
 */
export function GrepToolMessage({ args, result, output, running, isError }: ToolMessageRenderProps) {
  const view = grepCallView(args);
  const body = result === null || isError ? null : hashlineBody(result, output, 'grep', true);
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable defaultExpanded={false}>
      {({ expanded }) => {
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
            {expanded ? (
              isError ? (
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
                  {body.notice !== undefined ? <span className="text-doom-faint">{body.notice}</span> : null}
                </MessageItemBody>
              )
            ) : null}
          </>
        );
      }}
    </MessageItem>
  );
}
