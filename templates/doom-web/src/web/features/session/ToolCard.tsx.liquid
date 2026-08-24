import { useState } from 'react';
import type { ToolEntry } from '../../lib/sessionModel.ts';

const MAX_PREVIEW_LINES = 12;

// The mockup tints the whole card by outcome: amber while running, red on
// failure, and the resting border once it exited cleanly.
const CARD_BORDER = { running: 'border-[#574427]', error: 'border-[#6B3A3A]', ok: 'border-doom-border' };
const BADGE = {
  running: 'bg-[#312A1C] text-doom-yellow',
  error: 'bg-[#332428] text-doom-red',
  ok: 'bg-[#262E1E] text-doom-green',
};

export function ToolCard({ entry }: { entry: ToolEntry }) {
  const [expanded, setExpanded] = useState(false);
  const lines = entry.output.length > 0 ? entry.output.split('\n') : [];
  const clipped = !expanded && lines.length > MAX_PREVIEW_LINES;
  const shown = clipped ? lines.slice(0, MAX_PREVIEW_LINES) : lines;

  const state = entry.running ? 'running' : entry.isError ? 'error' : 'ok';
  const label = entry.running ? 'RUNNING' : entry.isError ? 'ERROR' : 'OK';

  return (
    <div
      data-testid="entry-tool"
      data-tool-name={entry.name}
      data-tool-state={state}
      className={`overflow-hidden rounded-md border bg-doom-panel ${CARD_BORDER[state]}`}
    >
      <div className="flex h-8 items-center gap-2 px-[11px]">
        <span className="text-[11px] font-bold text-doom-hi">{entry.name}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-doom-dim">{entry.argSummary}</span>
        <span
          data-testid="tool-status"
          className={`rounded-[3px] px-[7px] py-[3px] text-[9px] font-bold ${BADGE[state]}`}
        >
          {label}
        </span>
      </div>
      {lines.length > 0 ? (
        <div className="border-t border-doom-border-soft bg-doom-deep px-3 py-2">
          <pre data-testid="tool-output" className="whitespace-pre-wrap break-words text-[11px] text-doom-dim">
            {shown.join('\n')}
          </pre>
          {clipped ? (
            <button
              type="button"
              data-testid="tool-expand"
              onClick={() => setExpanded(true)}
              className="mt-1 text-[10px] text-doom-blue hover:underline"
            >
              show {lines.length - MAX_PREVIEW_LINES} more line(s)
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
