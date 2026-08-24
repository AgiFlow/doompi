import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { grepCallView } from './grepToolView.ts';
import { HashlineLines } from './HashlineLines.tsx';
import { hashlineBody, resultTextLines } from './hashlineView.ts';

/** The cockpit's half of the grep tool's renderCall: `pattern · path · glob · ignore case · N matches`. */
export function GrepToolCall({ args }: ToolCallRenderProps) {
  const view = grepCallView(args);
  return (
    <span data-testid="tool-call-grep" className="flex min-w-0 items-center gap-2">
      <span className="truncate text-doom-text">{view.pattern}</span>
      {view.details.length > 0 ? <span className="shrink-0 text-doom-faint">· {view.details.join(' · ')}</span> : null}
    </span>
  );
}

/**
 * The grep tool's renderResult: matches grouped under each file's path with
 * anchored line numbers and a `>>` marker, collapsed to the TUI's fifteen-line
 * budget until the card expands.
 */
export function GrepToolResult({ result, output, isPartial, isError, expanded }: ToolResultRenderProps) {
  if (isError) {
    const lines = resultTextLines(result, output);
    return (
      <div data-testid="tool-result-grep" className="flex flex-col">
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
      <span data-testid="tool-result-grep" className="text-doom-yellow">
        ◐ running
      </span>
    ) : null;
  }
  const body = hashlineBody(result, output, 'grep', expanded);
  if (body.shown.length === 0 && body.notice === undefined) return null;
  return (
    <div data-testid="tool-result-grep" className="flex flex-col gap-1">
      <HashlineLines lines={body.shown} gutter={body.gutter} />
      {body.hidden > 0 ? <span className="text-doom-faint">… {body.hidden} more lines · expand</span> : null}
      {body.notice !== undefined ? <span className="text-doom-faint">{body.notice}</span> : null}
    </div>
  );
}
