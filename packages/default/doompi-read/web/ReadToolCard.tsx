import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { HashlineLines } from './HashlineLines.tsx';
import { hashlineBody, resultTextLines } from './hashlineView.ts';
import { readCallView } from './readToolView.ts';

/** The cockpit's half of the read tool's renderCall: `path · from N · N lines`. */
export function ReadToolCall({ args }: ToolCallRenderProps) {
  const view = readCallView(args);
  return (
    <span data-testid="tool-call-read" className="flex min-w-0 items-center gap-2">
      <span className="truncate text-doom-text">{view.path}</span>
      {view.details.length > 0 ? <span className="shrink-0 text-doom-faint">· {view.details.join(' · ')}</span> : null}
    </span>
  );
}

/**
 * The read tool's renderResult: the anchored file body with a line-number
 * gutter, collapsed to the TUI's ten-line budget until the card expands.
 */
export function ReadToolResult({ result, output, isPartial, isError, expanded }: ToolResultRenderProps) {
  if (isError) {
    const lines = resultTextLines(result, output);
    return (
      <div data-testid="tool-result-read" className="flex flex-col">
        <span className="text-doom-red">✗ failed</span>
        {lines.map((line, index) => (
          <span key={index} className="whitespace-pre-wrap break-words text-doom-red">
            {line}
          </span>
        ))}
      </div>
    );
  }
  if (result === null) {
    return isPartial ? (
      <span data-testid="tool-result-read" className="text-doom-yellow">
        ◐ running
      </span>
    ) : null;
  }
  const body = hashlineBody(result, output, 'read', expanded);
  if (body.shown.length === 0 && body.notice === undefined) return null;
  return (
    <div data-testid="tool-result-read" className="flex flex-col gap-1">
      <HashlineLines lines={body.shown} gutter={body.gutter} />
      {body.hidden > 0 ? <span className="text-doom-faint">… {body.hidden} more lines · expand</span> : null}
      {body.notice !== undefined ? <span className="text-doom-faint">{body.notice}</span> : null}
    </div>
  );
}
