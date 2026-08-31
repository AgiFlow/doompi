import {
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageLines,
  VolumeIcon,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { VOICE_NARRATE_TOOL, voiceCallSummary, voiceResultLines } from './voiceToolRender.ts';

/**
 * The voice tools' timeline item. Facade calls keep their structured tool card.
 * Narration is conversational output rather than implementation detail, so its
 * spoken text stays in the transcript as a plain message with a speaker icon.
 */
export function VoiceToolMessage({ toolName, args, result, running, isError }: ToolMessageRenderProps) {
  if (toolName === VOICE_NARRATE_TOOL) {
    const text = typeof args.text === 'string' ? args.text.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
    return (
      <div
        role="group"
        aria-label="narration"
        data-testid="narration-message"
        data-narration-state={running ? 'playing' : isError ? 'failed' : 'complete'}
        className="flex min-w-0 items-start gap-2 text-[13px] text-doom-text"
      >
        <VolumeIcon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-doom-magenta" />
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{text || 'Narration unavailable.'}</p>
      </div>
    );
  }
  const summary = voiceCallSummary(toolName, args);
  const collapsed = voiceResultLines(toolName, result, { expanded: false, isError, isPartial: running });
  const full = voiceResultLines(toolName, result, { expanded: true, isError, isPartial: running });
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={full.length > collapsed.length}>
      {({ expanded }) => (
        <>
          <MessageItemHeader title={toolName}>
            <span data-testid={`tool-call-${toolName}`} className="flex min-w-0 flex-1 items-center gap-2">
              <span className="font-bold text-doom-hi">
                {summary.glyph} {summary.action}
              </span>
              {summary.detail ? (
                <span className={`min-w-0 truncate ${summary.detailIsName ? 'text-doom-blue' : 'text-doom-faint'}`}>
                  {summary.detail}
                </span>
              ) : null}
            </span>
          </MessageItemHeader>
          <MessageItemBody data-testid={`tool-result-${toolName}`}>
            <MessageLines lines={expanded ? full : collapsed} />
          </MessageItemBody>
        </>
      )}
    </MessageItem>
  );
}
