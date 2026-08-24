import { useState } from 'react';
import type { ToolEntry } from '../../lib/sessionModel.ts';
import { pluginToolRenderer } from '../../lib/pluginRegistry.ts';
import { useActiveSession } from '../../stores/sessionStore.ts';

const MAX_PREVIEW_LINES = 12;

// The mockup tints the whole card by outcome: amber while running, red on
// failure, and the resting border once it exited cleanly.
const CARD_BORDER = { running: 'border-[#574427]', error: 'border-[#6B3A3A]', ok: 'border-doom-border' };
const BADGE = {
  running: 'bg-[#312A1C] text-doom-yellow',
  error: 'bg-[#332428] text-doom-red',
  ok: 'bg-[#262E1E] text-doom-green',
};

/** The host's own body: the result's text, clipped until expanded. */
function DefaultOutput({ output, expanded, onExpand }: { output: string; expanded: boolean; onExpand: () => void }) {
  const lines = output.length > 0 ? output.split('\n') : [];
  if (lines.length === 0) return null;
  const clipped = !expanded && lines.length > MAX_PREVIEW_LINES;
  const shown = clipped ? lines.slice(0, MAX_PREVIEW_LINES) : lines;
  return (
    <div className="border-t border-doom-border-soft bg-doom-deep px-3 py-2">
      <pre data-testid="tool-output" className="whitespace-pre-wrap break-words text-[11px] text-doom-dim">
        {shown.join('\n')}
      </pre>
      {clipped ? (
        <button
          type="button"
          data-testid="tool-expand"
          onClick={onExpand}
          className="mt-1 text-[10px] text-doom-blue hover:underline"
        >
          show {lines.length - MAX_PREVIEW_LINES} more line(s)
        </button>
      ) : null}
    </div>
  );
}

/**
 * One tool call in the timeline. The frame (outcome tint, status badge,
 * expand state) is the host's; the header summary and the body come from the
 * plugin that registered the tool when it ships renderers, mirroring the
 * TUI's renderCall and renderResult, and fall back to the argument summary
 * and preformatted output otherwise.
 */
export function ToolCard({ entry, sessionId }: { entry: ToolEntry; sessionId: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const statuses = useActiveSession((state) => state.statuses);
  const renderer = pluginToolRenderer(entry.name, statuses);
  const Call = renderer?.call;
  const Result = renderer?.result;

  const state = entry.running ? 'running' : entry.isError ? 'error' : 'ok';
  const label = entry.running ? 'RUNNING' : entry.isError ? 'ERROR' : 'OK';
  const callProps = { sessionId, toolCallId: entry.toolCallId, toolName: entry.name, args: entry.args };

  return (
    <div
      data-testid="entry-tool"
      data-tool-name={entry.name}
      data-tool-state={state}
      data-tool-renderer={renderer ? 'plugin' : 'host'}
      className={`overflow-hidden rounded-md border bg-doom-panel ${CARD_BORDER[state]}`}
    >
      <div className="flex min-h-8 items-center gap-2 px-[11px]">
        <span className="text-[11px] font-bold text-doom-hi">{entry.name}</span>
        {Call ? (
          <div data-testid="tool-call" className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-doom-dim">
            <Call {...callProps} />
          </div>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] text-doom-dim">{entry.argSummary}</span>
        )}
        <span
          data-testid="tool-status"
          className={`rounded-[3px] px-[7px] py-[3px] text-[9px] font-bold ${BADGE[state]}`}
        >
          {label}
        </span>
        {Result ? (
          <button
            type="button"
            data-testid="tool-expand"
            onClick={() => setExpanded((value) => !value)}
            className="text-[10px] text-doom-faint hover:text-doom-blue"
            aria-label={expanded ? 'collapse tool result' : 'expand tool result'}
          >
            {expanded ? '▴' : '▾'}
          </button>
        ) : null}
      </div>
      {Result ? (
        <div
          data-testid="tool-result"
          className="border-t border-doom-border-soft bg-doom-deep px-3 py-2 text-[11px] text-doom-dim"
        >
          <Result
            {...callProps}
            result={entry.result}
            output={entry.output}
            isPartial={entry.running}
            isError={entry.isError}
            expanded={expanded}
          />
        </div>
      ) : (
        <DefaultOutput output={entry.output} expanded={expanded} onExpand={() => setExpanded(true)} />
      )}
    </div>
  );
}
