import type { ToolMessageRenderProps } from '@agimon-ai/doompi-core/web';
import {
  Button,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  MessageLines,
  toolTone,
} from '@agimon-ai/doompi-web-components';

import { authorFileTab } from '../../_components/AuthorDocumentPanel';

export function openAuthoringFileTab(
  path: string,
  openTransientTab: ToolMessageRenderProps['openTransientTab'],
  openTab: ToolMessageRenderProps['openTab'],
): void {
  const tab = authorFileTab(path);
  openTransientTab(tab);
  openTab(tab.id);
}

export function resultPath(result: ToolMessageRenderProps['result']): string | undefined {
  if (typeof result?.details !== 'object' || result.details === null || !('path' in result.details)) return undefined;
  return typeof result.details.path === 'string' ? result.details.path : undefined;
}

export function OpenAuthoringFileToolCard({
  args,
  result,
  running,
  isError,
  output,
  openTransientTab,
  openTab,
}: ToolMessageRenderProps) {
  const path = resultPath(result);
  const unavailable = !running && !isError && result !== null && path === undefined;
  const errorLines = isError
    ? (output ?? '')
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .slice(0, 4)
        .map((text) => ({ text, tone: 'error' as const }))
    : [];
  const requestedPath = typeof args.path === 'string' ? args.path : 'document';
  return (
    <MessageItem tone={toolTone({ running, isError: isError || unavailable })}>
      {() => (
        <>
          <MessageItemHeader title="open_authoring_file">
            <span data-testid="tool-call-open_authoring_file" className="min-w-0 flex-1 truncate text-doom-text">
              {requestedPath}
            </span>
          </MessageItemHeader>
          <MessageItemBody data-testid="tool-result-open_authoring_file" className="flex flex-col gap-1">
            {errorLines.length > 0 ? <MessageLines lines={errorLines} /> : null}
            <MessageItemStatus tone={isError || unavailable ? 'error' : running ? 'running' : undefined}>
              {isError
                ? 'failed'
                : running
                  ? 'validating'
                  : unavailable
                    ? 'unavailable'
                    : path === undefined
                      ? 'waiting'
                      : 'ready'}
            </MessageItemStatus>
            {!running && !isError && path !== undefined ? (
              <Button
                size="xs"
                variant="outline"
                data-testid="author-open-file"
                onClick={() => openAuthoringFileTab(path, openTransientTab, openTab)}
              >
                open in Author
              </Button>
            ) : null}
          </MessageItemBody>
        </>
      )}
    </MessageItem>
  );
}
