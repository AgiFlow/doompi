import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { resultText, writeCallView } from './builtinToolView.ts';

/** The cockpit's half of the write call heading: `path · N chars`. */
export function WriteToolCall({ args }: ToolCallRenderProps) {
  const view = writeCallView(args, false);
  return (
    <span data-testid="tool-call-write" className="flex min-w-0 items-center gap-2">
      <span className="truncate text-doom-text">{view.path}</span>
      <span className="shrink-0 text-doom-faint">· {view.size}</span>
    </span>
  );
}

/**
 * Pi's write result is silent on success, so the body shows the numbered
 * preview the TUI folds into its call: ten lines, or all of them once the
 * card expands. A failure shows the tool's message in red instead.
 */
export function WriteToolResult({ args, result, output, isPartial, isError, expanded }: ToolResultRenderProps) {
  if (isError) {
    return (
      <div data-testid="tool-result-write" className="flex flex-col">
        <span className="text-doom-red">✗ failed</span>
        <span className="whitespace-pre-wrap break-words text-doom-red">{resultText(result, output)}</span>
      </div>
    );
  }
  const view = writeCallView(args, expanded);
  if (view.preview.length === 0) {
    return isPartial ? (
      <span data-testid="tool-result-write" className="text-doom-yellow">
        ◐ running
      </span>
    ) : null;
  }
  return (
    <div data-testid="tool-result-write" className="flex flex-col font-mono">
      {view.preview.map((line) => (
        <span key={line.number} className="flex gap-2">
          <span className="shrink-0 text-right text-doom-faint" style={{ width: `${view.gutter}ch` }}>
            {line.number}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-words text-doom-text">{line.text}</span>
        </span>
      ))}
      {view.hidden > 0 ? <span className="text-doom-faint">… {view.hidden} more lines · expand</span> : null}
      {isPartial ? <span className="text-doom-yellow">◐ running</span> : null}
    </div>
  );
}
