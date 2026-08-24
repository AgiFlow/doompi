import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { findCallView } from './builtinToolView.ts';
import { ListingResult } from './ListingResult.tsx';

/** The find call heading: `pattern · path · N results`. */
export function FindToolCall({ args }: ToolCallRenderProps) {
  const view = findCallView(args);
  return (
    <span data-testid="tool-call-find" className="flex min-w-0 items-center gap-2">
      <span className="truncate text-doom-text">{view.primary}</span>
      {view.details.length > 0 ? <span className="shrink-0 text-doom-faint">· {view.details.join(' · ')}</span> : null}
    </span>
  );
}

export function FindToolResult(props: ToolResultRenderProps) {
  return <ListingResult tool="find" limitKey="resultLimitReached" limitUnit="results" props={props} />;
}
