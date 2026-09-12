import { describe, expect, it } from 'vitest';
import { createSessionPresentation } from '../../../../src/services/server/sessionPresentation.ts';

describe('session presentation replay', () => {
  it('keeps current statuses and unresolved dialogs when the event ring wraps', () => {
    const projection = createSessionPresentation();
    projection.record({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'mode', statusText: 'active' });
    projection.record({ type: 'extension_ui_request', method: 'confirm', id: 'kept', title: 'Keep?' });
    projection.record({ type: 'extension_ui_request', method: 'confirm', id: 'answered', title: 'Done?' });
    projection.record({ type: 'extension_ui_answered', id: 'answered' });
    for (let index = 0; index < 1100; index++) projection.record({ type: 'agent_settled' });
    const state = projection.record({
      type: 'extension_ui_request',
      method: 'setWidget',
      widgetKey: 'task',
      lines: ['running'],
    });
    expect(state?.dropped).toBeGreaterThan(0);
    expect(state?.events).toHaveLength(64);
    expect(state?.projections.map((event) => event.frame)).toEqual([
      expect.objectContaining({ statusKey: 'mode' }),
      expect.objectContaining({ id: 'kept' }),
      expect.objectContaining({ widgetKey: 'task' }),
    ]);
    expect(projection.record({ type: 'message_update', text: 'transcript-only' })).toBeUndefined();
    expect(projection.record({ type: 'response', command: 'get_entries', data: { entries: [] } })).toBeUndefined();
    expect(
      projection.record({
        type: 'response',
        command: 'get_available_models',
        data: { models: [{ apiKey: 'private' }] },
      }),
    ).toBeUndefined();
  });
  it('invalidates abandoned branch events while preserving live non-journal projections', () => {
    const projection = createSessionPresentation();
    projection.record({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'mode', statusText: 'active' });
    const previous = projection.record({
      type: 'entry_appended',
      entry: { type: 'custom', customType: 'branch', data: 'old' },
    });
    const reset = projection.resetCustomEntries();
    expect(reset.resetRevision).toBeGreaterThan(previous!.revision);
    expect(reset.events).toEqual([]);
    expect(reset.projections.map((event) => event.frame)).toEqual([expect.objectContaining({ statusKey: 'mode' })]);
    const restored = projection.record({
      type: 'entry_appended',
      entry: { type: 'custom', customType: 'branch', data: 'new' },
    });
    expect(restored?.resetRevision).toBe(reset.resetRevision);
    expect(JSON.stringify(restored)).not.toContain('old');
  });
});
