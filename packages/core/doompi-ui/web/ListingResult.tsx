import type { ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { listResultView, resultText } from './builtinToolView.ts';

/**
 * The body shared by find and ls: Pi's listing lines, collapsed to twenty
 * until the card expands, with the limit warning its details carry.
 */
export function ListingResult({
  tool,
  limitKey,
  limitUnit,
  props,
}: {
  tool: string;
  limitKey: string;
  limitUnit: string;
  props: ToolResultRenderProps;
}) {
  const { result, output, isPartial, isError, expanded } = props;
  if (isError) {
    return (
      <div data-testid={`tool-result-${tool}`} className="flex flex-col">
        <span className="text-doom-red">✗ failed</span>
        <span className="whitespace-pre-wrap break-words text-doom-red">{resultText(result, output)}</span>
      </div>
    );
  }
  if (result === null) {
    return isPartial ? (
      <span data-testid={`tool-result-${tool}`} className="text-doom-yellow">
        ◐ running
      </span>
    ) : null;
  }
  const view = listResultView(result, output, expanded, limitKey, limitUnit);
  if (view.lines.length === 0 && view.truncated === undefined) return null;
  return (
    <div data-testid={`tool-result-${tool}`} className="flex flex-col font-mono">
      {view.lines.map((line, index) => (
        <span key={index} className="whitespace-pre-wrap break-words text-doom-text">
          {line}
        </span>
      ))}
      {view.hidden > 0 ? <span className="text-doom-faint">… {view.hidden} more lines · expand</span> : null}
      {view.truncated !== undefined ? <span className="text-doom-yellow">{view.truncated}</span> : null}
    </div>
  );
}
