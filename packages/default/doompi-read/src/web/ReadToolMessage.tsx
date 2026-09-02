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
import { readCallView } from './readToolView.ts';

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function resultImages(content: readonly unknown[]): Array<{ data: string; mimeType: string }> {
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) return [];
    const value = block as Record<string, unknown>;
    return value.type === 'image' &&
      typeof value.data === 'string' &&
      typeof value.mimeType === 'string' &&
      IMAGE_MIME_TYPES.has(value.mimeType)
      ? [{ data: value.data, mimeType: value.mimeType }]
      : [];
  });
}
/**
 * The read tool's timeline item, the web half of its renderCall and
 * renderResult: the call summary in the header and the anchored lines with
 * a line-number gutter in the body, collapsed to the TUI's budget until the
 * item expands. A failure shows the tool's message in red instead.
 */
export function ReadToolMessage({ args, result, output, running, isError }: ToolMessageRenderProps) {
  const view = readCallView(args);
  const images = resultImages(result?.content ?? []);
  const collapsed = result === null || isError ? null : hashlineBody(result, output, 'read', false);
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={collapsed !== null && collapsed.hidden > 0}>
      {({ expanded }) => {
        const body =
          result === null || isError ? null : expanded ? hashlineBody(result, output, 'read', true) : collapsed;
        return (
          <>
            <MessageItemHeader title="read">
              <span data-testid="tool-call-read" className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-doom-text">{view.path}</span>
                {view.details.length > 0 ? (
                  <span className="shrink-0 text-doom-faint">· {view.details.join(' · ')}</span>
                ) : null}
              </span>
            </MessageItemHeader>
            {isError ? (
              <MessageItemBody data-testid="tool-result-read" className="flex flex-col">
                <MessageItemStatus tone="error">failed</MessageItemStatus>
                {resultTextLines(result, output).map((line, index) => (
                  <span key={`${String(index)}-${line}`} className="whitespace-pre-wrap break-words text-doom-red">
                    {line}
                  </span>
                ))}
              </MessageItemBody>
            ) : body === null ? (
              running ? (
                <MessageItemBody data-testid="tool-result-read">
                  <MessageItemStatus tone="running">running</MessageItemStatus>
                </MessageItemBody>
              ) : null
            ) : body.shown.length === 0 && body.notice === undefined && images.length === 0 ? null : (
              <MessageItemBody data-testid="tool-result-read" className="flex flex-col gap-1">
                {/* A read body is one file with no heading of its own, so the
                    call's path is what names the grammar for it. */}
                <HashlineLines lines={body.shown} gutter={body.gutter} path={view.path} />
                {images.map((image, index) => {
                  const url = `data:${image.mimeType};base64,${image.data}`;
                  return (
                    <a
                      key={`${image.mimeType}:${String(index)}`}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="self-start"
                    >
                      <img
                        src={url}
                        alt={`Read result ${String(index + 1)}`}
                        data-testid="tool-result-read-image"
                        className="h-auto max-h-96 max-w-full rounded-md border border-doom-border-soft object-contain"
                      />
                    </a>
                  );
                })}
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
