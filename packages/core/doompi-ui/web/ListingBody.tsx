import { MessageItemBody, MessageItemStatus } from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { listResultView, resultText } from './builtinToolView.ts';

/**
 * The body shared by find and ls: Pi's listing lines, collapsed to twenty
 * until the item expands, with the limit warning its details carry.
 */
export function ListingBody({
  tool,
  limitKey,
  limitUnit,
  expanded,
  props,
}: {
  tool: string;
  limitKey: string;
  limitUnit: string;
  expanded: boolean;
  props: ToolMessageRenderProps;
}) {
  const { result, output, running, isError } = props;
  if (isError) {
    return (
      <MessageItemBody data-testid={`tool-result-${tool}`} className="flex flex-col">
        <MessageItemStatus tone="error">failed</MessageItemStatus>
        <span className="whitespace-pre-wrap break-words text-doom-red">{resultText(result, output)}</span>
      </MessageItemBody>
    );
  }
  if (result === null) {
    return running ? (
      <MessageItemBody data-testid={`tool-result-${tool}`}>
        <MessageItemStatus tone="running">running</MessageItemStatus>
      </MessageItemBody>
    ) : null;
  }
  const view = listResultView(result, output, expanded, limitKey, limitUnit);
  if (view.lines.length === 0 && view.truncated === undefined) return null;
  return (
    <MessageItemBody data-testid={`tool-result-${tool}`} className="flex flex-col font-mono">
      {view.lines.map((line, index) => (
        <span key={`${String(index)}-${line}`} className="whitespace-pre-wrap break-words text-doom-text">
          {line}
        </span>
      ))}
      {view.hidden > 0 ? <MessageItemStatus expands>{view.hidden} more lines</MessageItemStatus> : null}
      {view.truncated !== undefined ? <span className="text-doom-yellow">{view.truncated}</span> : null}
    </MessageItemBody>
  );
}

/** Whether the listing hides lines while collapsed, so the item can offer its toggle. */
export function listingExpandable(props: ToolMessageRenderProps, limitKey: string, limitUnit: string): boolean {
  if (props.result === null || props.isError) return false;
  return listResultView(props.result, props.output, false, limitKey, limitUnit).hidden > 0;
}
