import { describe, expect, it } from 'vitest';
import type { TimelineEntry, ToolEntry } from '../../src/web/lib/sessionModel.ts';
import { groupSummary, groupTone, timelineUnits } from '../../src/web/lib/timelineGroups.ts';

function tool(id: string, name: string, state: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: 'tool',
    id,
    toolCallId: id,
    name,
    args: {},
    argSummary: '',
    result: null,
    output: '',
    isError: false,
    running: false,
    ...state,
  };
}

const assistant: TimelineEntry = { kind: 'assistant', id: 'a1', text: 'hi', thinking: '', streaming: false };
const always = (): boolean => true;

describe('timelineUnits', () => {
  it('gathers adjacent calls to the same tool into one unit', () => {
    const units = timelineUnits([tool('1', 'bash'), tool('2', 'bash'), tool('3', 'bash')], always);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: 'group', name: 'bash', index: 2 });
    expect(units[0]?.kind === 'group' ? units[0].entries.map((entry) => entry.id) : []).toEqual(['1', '2', '3']);
  });

  it('leaves a lone call as its own card, because one card is not a repetition', () => {
    const units = timelineUnits([tool('1', 'bash')], always);
    expect(units).toEqual([{ kind: 'single', entry: expect.objectContaining({ id: '1' }), index: 0 }]);
  });

  it('breaks a run at anything between the calls, so the transcript keeps its order', () => {
    const units = timelineUnits([tool('1', 'bash'), assistant, tool('3', 'bash'), tool('4', 'bash')], always);
    expect(units.map((unit) => unit.kind)).toEqual(['single', 'single', 'group']);
    expect(units[2]).toMatchObject({ index: 3 });
  });

  it('breaks a run when the tool changes', () => {
    const units = timelineUnits([tool('1', 'read'), tool('2', 'read'), tool('3', 'bash')], always);
    expect(units.map((unit) => unit.kind)).toEqual(['group', 'single']);
  });

  it('never groups a tool the caller rules out, such as one that renders as a message', () => {
    const units = timelineUnits([tool('1', 'voice'), tool('2', 'voice')], (name) => name !== 'voice');
    expect(units.map((unit) => unit.kind)).toEqual(['single', 'single']);
  });

  it('indexes each unit by its last entry, so the live-tail window measures the whole run', () => {
    const units = timelineUnits([assistant, tool('2', 'bash'), tool('3', 'bash')], always);
    expect(units.map((unit) => unit.index)).toEqual([0, 2]);
  });

  it('has nothing to say about an empty transcript', () => {
    expect(timelineUnits([], always)).toEqual([]);
  });
});

describe('groupTone', () => {
  it('reads as the worst outcome in the run', () => {
    expect(groupTone([tool('1', 'bash'), tool('2', 'bash')])).toBe('ok');
    expect(groupTone([tool('1', 'bash'), tool('2', 'bash', { isError: true })])).toBe('error');
    // Still going outranks a failure already in the run: the run is not over.
    expect(groupTone([tool('1', 'bash', { isError: true }), tool('2', 'bash', { running: true })])).toBe('running');
  });
});

describe('groupSummary', () => {
  it('counts the calls, and says call rather than calls for one', () => {
    expect(groupSummary([tool('1', 'bash'), tool('2', 'bash')])).toBe('2 calls');
    expect(groupSummary([tool('1', 'bash')])).toBe('1 call');
  });
});
