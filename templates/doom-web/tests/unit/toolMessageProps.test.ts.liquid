import { describe, expect, it } from 'vitest';
import type { ToolEntry } from '../../src/web/lib/sessionModel.ts';
import { pluginSlotProps } from '../../src/web/lib/pluginSlotProps.ts';
import { toolMessageProps } from '../../src/web/lib/toolMessageProps.ts';

describe('toolMessageProps', () => {
  it('hands a tool message the slot actions plus the call and its newest result', () => {
    const openTab = (): void => undefined;
    const slotProps = pluginSlotProps(
      's1',
      openTab,
      {},
      { open: () => undefined, close: () => undefined },
      () => undefined,
      () => undefined,
    );
    const entry: ToolEntry = {
      kind: 'tool',
      id: 'e1',
      toolCallId: 'call-1',
      name: 'bash',
      args: { command: 'ls' },
      argSummary: 'ls',
      result: { content: [{ type: 'text', text: 'a' }], details: { tail: 'a' } },
      output: 'a',
      isError: false,
      running: true,
    };
    const props = toolMessageProps(slotProps, entry, { 'doom-mcp': 'github' });
    expect(props).toMatchObject({
      sessionId: 's1',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'ls' },
      statuses: { 'doom-mcp': 'github' },
      result: entry.result,
      output: 'a',
      running: true,
      isError: false,
    });
    expect(props.openTab).toBe(openTab);
    expect(props.sendSessionFrame).toBe(slotProps.sendSessionFrame);
    expect(props.renderSlot).toBe(slotProps.renderSlot);
    expect(props.slotData).toBe(slotProps.slotData);
  });
});
