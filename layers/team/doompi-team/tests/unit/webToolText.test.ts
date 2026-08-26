import { describe, expect, it } from 'vitest';
import {
  COLLAPSED_RESULT_LINES,
  intercomCallSummary,
  intercomOutcome,
  resultLines,
  shapeResult,
  subagentCallDetail,
} from '../../web/toolText.ts';

describe('the subagent card text', () => {
  it('words the call detail per action the way the TUI does', () => {
    expect(subagentCallDetail({ action: 'agents' })).toBe('');
    expect(subagentCallDetail({ action: 'agents', name: 'reviewer' })).toBe('reviewer');
    expect(subagentCallDetail({ action: 'run', requests: [{ agent: 'a', task: 't' }] })).toBe('1 agent · a');
    expect(
      subagentCallDetail({
        action: 'run',
        requests: [
          { agent: 'a', task: 't' },
          { agent: 'b', task: 't' },
        ],
      }),
    ).toBe('2 agents · a, b');
    expect(subagentCallDetail({ action: 'run', requests: 'junk' })).toBe('0 agents');
    expect(subagentCallDetail({ action: 'status' })).toBe('fleet');
    expect(subagentCallDetail({ action: 'status', id: 'run-1' })).toBe('run-1');
    expect(subagentCallDetail({ action: 'steer', id: 'run-2' })).toBe('run-2');
    expect(subagentCallDetail({ action: 'stop', id: 'run-3' })).toBe('run-3');
    expect(subagentCallDetail({ action: 'restore', id: 'run-4' })).toBe('run-4');
    expect(subagentCallDetail({ action: 'suspended' })).toBe('runs');
    expect(subagentCallDetail({ action: 'unknown' })).toBe('');
  });

  it('drops trailing blank lines and treats empty output as no lines', () => {
    expect(resultLines('')).toEqual([]);
    expect(resultLines('a\nb\n\n  \n')).toEqual(['a', 'b']);
  });

  it('shows a tail while running, a collapsed head after, and the closing glyph', () => {
    const many = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
    const running = shapeResult(many, { expanded: false, isPartial: true, isError: false });
    expect(running.glyph).toBe('running');
    expect(running.lines).toHaveLength(COLLAPSED_RESULT_LINES);
    expect(running.lines[0]).toBe('line 9');

    const collapsed = shapeResult(many, { expanded: false, isPartial: false, isError: false });
    expect(collapsed).toMatchObject({ glyph: 'more', hidden: 8 });
    expect(collapsed.lines[0]).toBe('line 1');

    const expanded = shapeResult(many, { expanded: true, isPartial: false, isError: false });
    expect(expanded).toMatchObject({ glyph: 'none', hidden: 0 });
    expect(expanded.lines).toHaveLength(20);

    expect(shapeResult('boom', { expanded: false, isPartial: false, isError: true })).toMatchObject({
      lines: ['boom'],
      glyph: 'failed',
    });
    expect(shapeResult('', { expanded: false, isPartial: false, isError: false })).toMatchObject({ glyph: 'done' });
  });
});

describe('the intercom card text', () => {
  it('names the target and previews the message per action', () => {
    expect(intercomCallSummary({ action: 'members' })).toEqual({ action: 'members', target: '', message: '' });
    expect(intercomCallSummary({ action: 'pending' })).toEqual({ action: 'pending', target: '', message: '' });
    expect(intercomCallSummary({ action: 'send', to: 'main', message: 'done\nwith  it' })).toEqual({
      action: 'send',
      target: 'main',
      message: 'done with it',
    });
    expect(intercomCallSummary({ action: 'ask', to: 'w1', message: 'x'.repeat(100) }).message).toHaveLength(72);
    expect(intercomCallSummary({ action: 'reply', requestId: 'req-1', message: 'ok' })).toEqual({
      action: 'reply',
      target: 'req-1',
      message: 'ok',
    });
    expect(intercomCallSummary({})).toEqual({ action: '', target: '', message: '' });
  });

  it('reads the outcome from the details the tool attaches', () => {
    expect(intercomOutcome(undefined)).toEqual({ outcome: 'none', who: '' });
    expect(intercomOutcome({ delivered: true, to: 'main' })).toEqual({ outcome: 'delivered', who: 'main' });
    expect(intercomOutcome({ state: 'queued', delivered: false, to: 'w1' })).toEqual({ outcome: 'queued', who: 'w1' });
    expect(intercomOutcome({ requestId: 'r', from: 'w1', reply: 'yes' })).toEqual({ outcome: 'answered', who: 'w1' });
    expect(intercomOutcome({ requestId: 'r', to: 'main' })).toEqual({ outcome: 'replied', who: 'main' });
    expect(intercomOutcome({ members: [] })).toEqual({ outcome: 'none', who: '' });
  });
});
