import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import {
  type BashStatusTone,
  bashResultDetails,
  bashResultView,
  formatBashCommand,
  formatBashFlags,
} from './bashToolFormat.ts';

const STATUS_TONE: Record<BashStatusTone, string> = {
  running: 'text-doom-yellow',
  ok: 'text-doom-green',
  error: 'text-doom-red',
  background: 'text-doom-blue',
};

/** The call half of the bash card: the collapsed command and its modifiers, as the TUI's renderBashCall shows them. */
export function BashCall({ args }: ToolCallRenderProps) {
  const command = typeof args.command === 'string' ? formatBashCommand(args.command) : '';
  const flags = formatBashFlags(args);
  return (
    <span data-testid="tool-call-bash" className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-doom-text">{command}</span>
      {flags.length > 0 ? <span className="shrink-0 text-doom-faint">· {flags.join(' · ')}</span> : null}
    </span>
  );
}

/**
 * The result half: the streamed tail while running, then the bounded log tail
 * with the one-line footer summary (lines · size · runner), as renderBashResult
 * lays it out. Expanding the card shows the whole tail the runner sent.
 */
export function BashResult({ result, output, expanded, isPartial, isError }: ToolResultRenderProps) {
  const view = bashResultView({ details: result?.details, output, expanded, isPartial, isError });
  const logPath = bashResultDetails(result?.details).logPath;
  if (view.lines.length === 0 && view.status === null) return null;
  return (
    <div data-testid="tool-result-bash" className="flex flex-col gap-1">
      {view.lines.length > 0 ? (
        <pre
          className={`${expanded ? 'whitespace-pre-wrap break-words' : 'overflow-hidden whitespace-pre'} font-mono text-doom-dim`}
        >
          {view.lines.join('\n')}
        </pre>
      ) : null}
      {view.status ? (
        <span data-testid="tool-result-bash-status" className="flex items-center gap-1.5 text-doom-faint">
          <span className={STATUS_TONE[view.status.tone]}>{view.status.glyph}</span>
          <span>{view.status.text}</span>
          {view.hidden > 0 ? <span>· {view.hidden} more line(s) above</span> : null}
        </span>
      ) : null}
      {expanded && logPath !== undefined ? (
        // The tail is bounded by the runner; the whole log only ever exists on
        // disk, so the card names the file rather than pretending this is all.
        <span data-testid="tool-result-bash-log" className="truncate text-doom-faint">
          full log · <span className="text-doom-dim">{logPath}</span>
        </span>
      ) : null}
    </div>
  );
}
