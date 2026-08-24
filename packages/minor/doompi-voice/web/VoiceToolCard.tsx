import type { ToolCallRenderProps, ToolResultRenderProps } from '@agimon-ai/doompi-web-contracts';
import { type LineTone, voiceCallSummary, voiceResultLines } from './voiceToolRender.ts';

// The TUI's theme colors mapped onto the cockpit's tokens.
const TONE: Record<LineTone, string> = {
  hi: 'text-doom-hi',
  text: 'text-doom-text',
  dim: 'text-doom-dim',
  muted: 'text-doom-faint',
  success: 'text-doom-green',
  error: 'text-doom-red',
  warning: 'text-doom-yellow',
  accent: 'text-doom-blue',
};

/** The call half: discover, run, or narrate with the capability or speech preview. */
export function VoiceCall({ toolName, args }: ToolCallRenderProps) {
  const summary = voiceCallSummary(toolName, args);
  return (
    <span data-testid={`tool-call-${toolName}`} className="flex min-w-0 items-center gap-2">
      <span className="font-bold text-doom-hi">
        {summary.glyph ? `${summary.glyph} ` : ''}
        {summary.action}
      </span>
      {summary.detail ? (
        <span className={`min-w-0 truncate ${summary.detailIsName ? 'text-doom-blue' : 'text-doom-faint'}`}>
          {summary.detail}
        </span>
      ) : null}
    </span>
  );
}

/** The result half: the capability catalog, the batch outcome, or the narration status line. */
export function VoiceResult({ toolName, result, expanded, isError, isPartial }: ToolResultRenderProps) {
  const lines = voiceResultLines(toolName, result, { expanded, isError, isPartial });
  return (
    <div data-testid={`tool-result-${toolName}`} className="flex flex-col gap-0.5">
      {lines.map((entry, index) => (
        <div
          key={`${index}-${entry.text}`}
          className={`whitespace-pre-wrap break-words ${TONE[entry.tone]} ${entry.bold ? 'font-bold' : ''} ${
            entry.indent ? 'pl-4' : ''
          }`}
        >
          {entry.text}
        </div>
      ))}
    </div>
  );
}
