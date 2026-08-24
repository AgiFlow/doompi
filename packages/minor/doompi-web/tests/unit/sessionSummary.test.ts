import { describe, expect, it } from 'vitest';
import {
  abbreviateCwd,
  formatRunDuration,
  runningCount,
  sessionStatusLine,
  type StatusLineInput,
} from '../../src/web/lib/sessionSummary.ts';

const NOW = Date.parse('2026-08-24T10:12:00.000Z');

function input(overrides: Partial<StatusLineInput> = {}): StatusLineInput {
  return {
    attach: 'attached',
    phase: 'idle',
    phaseSince: '2026-08-24T10:00:00.000Z',
    awaitingInput: false,
    everPrompted: true,
    ...overrides,
  };
}

describe('sessionStatusLine', () => {
  it('lets a refusal outrank everything', () => {
    expect(sessionStatusLine(input({ attach: 'refused', phase: 'turn', awaitingInput: true }), NOW)).toBe(
      'another cockpit holds this session',
    );
  });

  it('lets a pending question outrank a running phase', () => {
    expect(sessionStatusLine(input({ phase: 'turn', awaitingInput: true }), NOW)).toBe('waiting for your input');
  });

  it('reports a running phase with its age', () => {
    expect(sessionStatusLine(input({ phase: 'turn' }), NOW)).toBe('running · 12m');
    expect(sessionStatusLine(input({ phase: 'compaction' }), NOW)).toBe('running · 12m');
  });

  it('describes a fresh session', () => {
    expect(sessionStatusLine(input({ everPrompted: false }), NOW)).toBe('fresh session · nothing sent yet');
  });

  it('treats an unprompted but settled session as finished, not fresh', () => {
    expect(sessionStatusLine(input({ everPrompted: false, lastSettledAt: '2026-08-24T10:05:00.000Z' }), NOW)).toBe(
      'The agent finished its work and is waiting for you.',
    );
  });

  it('falls back to the settled line', () => {
    expect(sessionStatusLine(input(), NOW)).toBe('The agent finished its work and is waiting for you.');
  });

  it('survives an unparseable timestamp', () => {
    expect(sessionStatusLine(input({ phase: 'turn', phaseSince: 'not-a-date' }), NOW)).toBe('running · <1m');
  });
});

describe('formatRunDuration', () => {
  it('formats the boundaries the rail shows', () => {
    expect(formatRunDuration(0)).toBe('<1m');
    expect(formatRunDuration(59_000)).toBe('<1m');
    expect(formatRunDuration(60_000)).toBe('1m');
    expect(formatRunDuration(12 * 60_000)).toBe('12m');
    expect(formatRunDuration(65 * 60_000)).toBe('1h 05m');
    expect(formatRunDuration(3 * 3_600_000 + 30 * 60_000)).toBe('3h 30m');
  });
});

describe('runningCount', () => {
  it('counts everything not idle', () => {
    expect(runningCount(['idle', 'turn', 'compaction', 'idle', 'retry'])).toBe(3);
    expect(runningCount([])).toBe(0);
  });
});

describe('abbreviateCwd', () => {
  it('shortens home-rooted paths on macOS and Linux', () => {
    expect(abbreviateCwd('/Users/dev/workspace/doompi')).toBe('~/workspace/doompi');
    expect(abbreviateCwd('/home/dev/src')).toBe('~/src');
    expect(abbreviateCwd('/Users/dev')).toBe('~');
  });

  it('leaves other paths alone', () => {
    expect(abbreviateCwd('/srv/app')).toBe('/srv/app');
    expect(abbreviateCwd('/Userspace/x')).toBe('/Userspace/x');
  });
});
