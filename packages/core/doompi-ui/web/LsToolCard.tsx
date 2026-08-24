import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { lsCallView } from './builtinToolView.ts';
import { ListingResult } from './ListingResult.tsx';

/** The ls call heading: `path · N entries`. */
export function LsToolCall({ args }: ToolCallRenderProps) {
  const view = lsCallView(args);
  return (
    <span data-testid="tool-call-ls" className="flex min-w-0 items-center gap-2">
      <span className="truncate text-doom-text">{view.primary}</span>
      {view.details.length > 0 ? <span className="shrink-0 text-doom-faint">· {view.details.join(' · ')}</span> : null}
    </span>
  );
}

export function LsToolResult(props: ToolResultRenderProps) {
  return <ListingResult tool="ls" limitKey="entryLimitReached" limitUnit="entries" props={props} />;
}
