import { describe, expect, it, vi } from 'vitest';
import {
  baselineOf,
  foldEntries,
  foldVersions,
  isDiffable,
  parseTimeline,
  parseTimelineEvent,
} from '../../../src/services/fileChanges.ts';

const line = (value: unknown): string => JSON.stringify(value);

describe('parseTimelineEvent', () => {
  it('reads a version 2 event with its snapshots and counts', () => {
    expect(
      parseTimelineEvent({
        version: 2,
        path: '/a.ts',
        tool: 'edit',
        at: 5,
        origin: 'tool',
        before: 'aa',
        after: 'bb',
        additions: 3,
        removals: 1,
      }),
    ).toEqual({
      version: 2,
      path: '/a.ts',
      tool: 'edit',
      at: 5,
      origin: 'tool',
      before: 'aa',
      after: 'bb',
      additions: 3,
      removals: 1,
    });
  });

  it('still reads a version 1 event, because a running session keeps writing them', () => {
    expect(parseTimelineEvent({ version: 1, path: '/a.ts', tool: 'edit', at: 5 })).toEqual({
      version: 1,
      path: '/a.ts',
      tool: 'edit',
      at: 5,
    });
  });

  it('defaults a version 2 event with no origin to a tool change', () => {
    expect(parseTimelineEvent({ version: 2, path: '/a.ts', tool: 'write', at: 5 })).toMatchObject({ origin: 'tool' });
  });

  it.each([
    ['a version it does not know', { version: 3, path: '/a.ts', tool: 'edit', at: 1 }],
    ['a tool it does not know', { version: 2, path: '/a.ts', tool: 'compile', at: 1 }],
    ['a manual save claimed by the older vocabulary', { version: 1, path: '/a.ts', tool: 'user', at: 1 }],
    ['no path', { version: 2, tool: 'edit', at: 1 }],
    ['no timestamp', { version: 2, path: '/a.ts', tool: 'edit' }],
    ['not an object', 'nonsense'],
  ])('rejects %s', (_name, input) => {
    expect(parseTimelineEvent(input)).toBeNull();
  });
});

describe('parseTimeline', () => {
  it('keeps the good lines and reports each bad one', () => {
    const onMalformed = vi.fn();
    const events = parseTimeline(
      [
        line({ version: 2, path: '/a.ts', tool: 'edit', at: 1, origin: 'tool' }),
        '{not json',
        line({ version: 9, path: '/b.ts', tool: 'edit', at: 2 }),
        '',
        line({ version: 1, path: '/c.ts', tool: 'bash', at: 3 }),
      ].join('\n'),
      onMalformed,
    );
    expect(events.map((event) => event.path)).toEqual(['/a.ts', '/c.ts']);
    expect(onMalformed).toHaveBeenCalledTimes(2);
  });
});

describe('foldEntries', () => {
  it('counts repeats per file and orders by the most recent change', () => {
    const events = parseTimeline(
      [
        line({ version: 2, path: '/a.ts', tool: 'edit', at: 10, origin: 'tool' }),
        line({ version: 2, path: '/b.ts', tool: 'write', at: 20, origin: 'tool' }),
        line({ version: 2, path: '/a.ts', tool: 'bash', at: 30, origin: 'scan' }),
      ].join('\n'),
    );
    expect(foldEntries(events)).toEqual([
      { path: '/a.ts', tool: 'bash', at: 30, count: 2 },
      { path: '/b.ts', tool: 'write', at: 20, count: 1 },
    ]);
  });

  it('keeps the newest tool even when the lines arrived out of order', () => {
    const events = parseTimeline(
      [
        line({ version: 2, path: '/a.ts', tool: 'bash', at: 30, origin: 'scan' }),
        line({ version: 2, path: '/a.ts', tool: 'edit', at: 10, origin: 'tool' }),
      ].join('\n'),
    );
    expect(foldEntries(events)[0]).toMatchObject({ tool: 'bash', at: 30, count: 2 });
  });
});

describe('foldVersions', () => {
  const events = parseTimeline(
    [
      line({ version: 2, path: '/a.ts', tool: 'edit', at: 30, origin: 'tool', before: 'b2', after: 'a2' }),
      line({ version: 2, path: '/other.ts', tool: 'edit', at: 20, origin: 'tool' }),
      line({ version: 2, path: '/a.ts', tool: 'bash', at: 10, origin: 'scan', after: 'a1' }),
    ].join('\n'),
  );

  it('numbers one file’s changes oldest first and ignores every other file', () => {
    expect(foldVersions(events, '/a.ts').map((version) => [version.index, version.at, version.origin])).toEqual([
      [1, 10, 'scan'],
      [2, 30, 'tool'],
    ]);
  });

  it('answers nothing for a file the session never touched', () => {
    expect(foldVersions(events, '/absent.ts')).toEqual([]);
  });

  it('finds a file diffable only once some change captured a baseline', () => {
    const versions = foldVersions(events, '/a.ts');
    expect(isDiffable(versions)).toBe(true);
    expect(baselineOf(versions)).toBe('b2');
    // A file only ever seen after the fact has no baseline and never can have one.
    const scanOnly = foldVersions(events, '/a.ts').filter((version) => version.origin === 'scan');
    expect(isDiffable(scanOnly)).toBe(false);
    expect(baselineOf(scanOnly)).toBeUndefined();
  });
});
