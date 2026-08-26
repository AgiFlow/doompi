import {
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageLines,
  toolTone,
} from '@agimon-ai/doompi-web-components';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { planCallSummary, planResultLines } from './planToolRender.ts';

/**
 * The plan tools' timeline item: the plan action, the issue or decision it
 * targets, and what the packet carries in the header; the outcome line, with
 * the recorded evidence or the Fable draft once expanded, in the body.
 */
export function PlanToolMessage({ toolName, args, result, running, isError }: ToolMessageRenderProps) {
  const summary = planCallSummary(toolName, args);
  const collapsed = planResultLines(toolName, args, result, { expanded: false, isError, isPartial: running });
  const full = planResultLines(toolName, args, result, { expanded: true, isError, isPartial: running });
  return (
    <MessageItem tone={toolTone({ running, isError })} expandable={full.length > collapsed.length}>
      {({ expanded }) => (
        <>
          <MessageItemHeader title={toolName}>
            <span data-testid={`tool-call-${toolName}`} className="flex min-w-0 flex-1 items-center gap-2">
              <span className="font-bold text-doom-hi">{summary.action}</span>
              {summary.detail ? <span className="min-w-0 truncate text-doom-faint">{summary.detail}</span> : null}
              {summary.metadata.map((value) => (
                <span key={value} className="shrink-0 text-doom-dim">
                  · {value}
                </span>
              ))}
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
