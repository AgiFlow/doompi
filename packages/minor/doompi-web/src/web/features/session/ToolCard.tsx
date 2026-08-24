import {
  Button,
  ChevronDownIcon,
  ChevronUpIcon,
  STATUS_EDGE,
  StatusBadge,
  type StatusTone,
} from '@agimon-ai/doompi-web-components';
import { useState } from 'react';
import type { ToolEntry } from '../../lib/sessionModel.ts';
import { pluginToolRenderer } from '../../lib/pluginRegistry.ts';
import { useActiveSession } from '../../stores/sessionStore.ts';

const MAX_PREVIEW_LINES = 12;

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
        <Button variant="link" size="xs" data-testid="tool-expand" onClick={onExpand} className="mt-1 px-0">
          show {lines.length - MAX_PREVIEW_LINES} more line(s)
        </Button>
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
  const tone: StatusTone = state;
  const label = entry.running ? 'RUNNING' : entry.isError ? 'ERROR' : 'OK';
  const callProps = { sessionId, toolCallId: entry.toolCallId, toolName: entry.name, args: entry.args, statuses };
  const resultProps = {
    ...callProps,
    result: entry.result,
    output: entry.output,
    isPartial: entry.running,
    isError: entry.isError,
    expanded,
  };
  // A toggle that would reveal nothing reads as a broken control, so the card
  // only offers one when something is actually hidden. The plugin contract has
  // no expandability probe, so this is decided from what the host can see: a
  // result the preview clips, or structured details a renderer can unfold
  // (the runner's log path and byte count, a diff's full hunks). A tool that
  // threw carries neither, and its card correctly offers nothing.
  const clipped = entry.output.split('\n').length > MAX_PREVIEW_LINES;
  const expandable = Result !== undefined && (clipped || entry.result?.details !== undefined);

  return (
    <div
      data-testid="entry-tool"
      data-tool-name={entry.name}
      data-tool-state={state}
      data-tool-renderer={renderer ? 'plugin' : 'host'}
      className={`overflow-hidden rounded-md border bg-doom-panel transition-colors ${STATUS_EDGE[tone]}`}
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
        <StatusBadge tone={tone} data-testid="tool-status">
          {label}
        </StatusBadge>
        {expandable ? (
          <Button
            variant="ghost"
            size="icon"
            data-testid="tool-expand"
            onClick={() => setExpanded((value) => !value)}
            className="text-doom-faint hover:text-doom-blue"
            aria-label={expanded ? 'collapse tool result' : 'expand tool result'}
          >
            {expanded ? <ChevronUpIcon className="h-3 w-3" /> : <ChevronDownIcon className="h-3 w-3" />}
          </Button>
        ) : null}
      </div>
      {Result ? (
        <div
          data-testid="tool-result"
          className="border-t border-doom-border-soft bg-doom-deep px-3 py-2 text-[11px] text-doom-dim"
        >
          <Result {...resultProps} />
        </div>
      ) : (
        <DefaultOutput output={entry.output} expanded={expanded} onExpand={() => setExpanded(true)} />
      )}
    </div>
  );
}
