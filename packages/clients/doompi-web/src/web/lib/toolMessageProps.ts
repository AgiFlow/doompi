import type { ToolMessageRenderProps, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';

import type { ToolEntry } from './sessionModel';

/** The props a tool's message renderer receives: the slot actions plus the call and its newest result. */
export function toolMessageProps(
  slotProps: WebPluginSlotProps,
  entry: ToolEntry,
  statuses: Readonly<Record<string, string>>,
): ToolMessageRenderProps {
  return {
    ...slotProps,
    toolCallId: entry.toolCallId,
    toolName: entry.name,
    args: entry.args,
    statuses,
    result: entry.result,
    output: entry.output,
    running: entry.running,
    isError: entry.isError,
  };
}
