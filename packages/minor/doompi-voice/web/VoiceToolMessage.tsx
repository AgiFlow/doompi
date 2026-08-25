import {
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageLines,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { voiceCallSummary, voiceResultLines } from './voiceToolRender.ts';

/**
 * The voice tools' timeline item: discover, run, or narrate with the
 * capability or speech preview in the header; the capability catalog, the
 * batch outcome, or the narration status line in the body.
 */
export function VoiceToolMessage({ toolName, args, result, running, isError }: ToolMessageRenderProps) {
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
                {summary.glyph ? `${summary.glyph} ` : ''}
                {summary.action}
              </span>
              {summary.detail ? (
                <span className={`min-w-0 truncate ${summary.detailIsName ? 'text-doom-blue' : 'text-doom-faint'}`}>
                  {summary.detail}
                </span>
              ) : null}
            </span>
          </MessageItemHeader>
          {(expanded ? full : collapsed).length > 0 ? (
            <MessageItemBody data-testid={`tool-result-${toolName}`}>
              <MessageLines lines={expanded ? full : collapsed} />
            </MessageItemBody>
          ) : null}
        </>
      )}
    </MessageItem>
  );
}
