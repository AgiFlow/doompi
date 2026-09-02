import {
  Button,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { subagentsTab } from './SubagentsPanel.tsx';
import { shapeResult, subagentCallDetail } from './toolText.ts';

const CLOSING = {
  running: { tone: 'running', text: 'running' },
  failed: { tone: 'error', text: 'failed' },
  done: { tone: 'ok', text: 'done' },
} as const;

/**
 * The subagent tool's timeline item, the web half of renderSubagentCall and
 * renderSubagentResult: the action and its per-action detail in the header,
 * the framed text lines with the closing status line in the body, and the
 * subagents tab one click away while a run is on the go.
 */
export function SubagentToolMessage({ args, output, running, isError, openTransientTab }: ToolMessageRenderProps) {
  const action = typeof args.action === 'string' ? args.action : '';
  const detail = subagentCallDetail(args);
  const collapsed = shapeResult(output, { expanded: false, isPartial: running, isError });
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={collapsed.glyph === 'more'}>
      {({ expanded }) => {
        const shaped = expanded ? shapeResult(output, { expanded: true, isPartial: running, isError }) : collapsed;
        const closing = shaped.glyph === 'none' || shaped.glyph === 'more' ? null : CLOSING[shaped.glyph];
        return (
          <>
            <MessageItemHeader title="subagent">
              <span data-testid="tool-call-subagent" className="flex min-w-0 flex-1 items-center gap-2">
                <span className="text-doom-hi">{action}</span>
                {detail ? <span className="min-w-0 truncate text-doom-cyan">{detail}</span> : null}
              </span>
            </MessageItemHeader>
            <MessageItemBody data-testid="tool-result-subagent" className="flex flex-col gap-1">
              {shaped.lines.length > 0 ? (
                <pre className={`${expanded ? 'whitespace-pre-wrap break-words' : 'truncate'} text-doom-dim`}>
                  {shaped.lines.join('\n')}
                </pre>
              ) : null}
              {closing ? <MessageItemStatus tone={closing.tone}>{closing.text}</MessageItemStatus> : null}
              {shaped.glyph === 'more' ? (
                <MessageItemStatus expands>{shaped.hidden} more line(s)</MessageItemStatus>
              ) : null}
              <Button
                variant="link"
                size="xs"
                data-testid="tool-result-subagent-open"
                onClick={() => openTransientTab(subagentsTab())}
                className="self-start px-0"
              >
                open subagents
              </Button>
            </MessageItemBody>
          </>
        );
      }}
    </MessageItem>
  );
}
