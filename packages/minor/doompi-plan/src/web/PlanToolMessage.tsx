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
          <MessageItemHeader title={summary.action}>
            <span
              data-testid={`tool-call-${toolName}`}
              title={[summary.detail, ...summary.metadata].filter(Boolean).join(' · ') || undefined}
              className="min-w-0 flex-1 truncate text-doom-dim"
            >
              {[summary.detail, ...summary.metadata].filter(Boolean).join(' · ')}
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
