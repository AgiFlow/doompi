import {
  Button,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { authorFileTab } from './AuthorDocumentPanel.tsx';

export function openAuthoringFileTab(
  path: string,
  openTransientTab: ToolMessageRenderProps['openTransientTab'],
  openTab: ToolMessageRenderProps['openTab'],
): void {
  const tab = authorFileTab(path);
  openTransientTab(tab);
  openTab(tab.id);
}

function resultPath(result: ToolMessageRenderProps['result']): string | undefined {
  if (typeof result?.details !== 'object' || result.details === null || !('path' in result.details)) return undefined;
  return typeof result.details.path === 'string' ? result.details.path : undefined;
}

export function OpenAuthoringFileToolCard({
  args,
  result,
  running,
  isError,
  openTransientTab,
  openTab,
}: ToolMessageRenderProps) {
  const path = resultPath(result);

  const requestedPath = typeof args.path === 'string' ? args.path : 'document';
  return (
    <MessageItem tone={toolTone({ running, isError })}>
      {() => (
        <>
          <MessageItemHeader title="open_authoring_file">
            <span data-testid="tool-call-open_authoring_file" className="min-w-0 flex-1 truncate text-doom-text">
              {requestedPath}
            </span>
          </MessageItemHeader>
          <MessageItemBody data-testid="tool-result-open_authoring_file">
            <MessageItemStatus tone={isError ? 'error' : running ? 'running' : undefined}>
              {isError ? 'failed' : running ? 'validating' : path === undefined ? 'waiting' : 'ready'}
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
