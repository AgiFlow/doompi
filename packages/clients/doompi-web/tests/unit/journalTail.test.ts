import { describe, expect, it } from 'vitest';
import { journalFrames, retainNewest } from '../../src/services/journalTail.ts';

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const ids = (frames: Array<Record<string, unknown>>): string[] =>
  frames.map((frame) => (frame.entry as { id: string }).id);

describe('journalTail', () => {
  it('folds message entries into entry_appended frames and skips everything else', () => {
    const user = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
    const text =
      line({ type: 'session', id: 'sess', version: 1 }) +
      line({ type: 'message', id: 'm1', parentId: null, message: user }) +
      line({ type: 'model_change', id: 'x1', model: 'm' }) +
      'not json\n' +
      line({ type: 'message', id: '', message: user }) +
      line({ type: 'message', id: 'm2', message: 'text' }) +
      '\n' +
      line({ type: 'message', id: 'm3', message: { role: 'assistant', content: [] } });
    const frames = journalFrames(text);
    expect(ids(frames)).toEqual(['m1', 'm3']);
    expect(frames[0]).toEqual({
      type: 'entry_appended',
      entry: { type: 'message', id: 'm1', parentId: null, message: user },
    });
    expect(journalFrames('')).toEqual([]);
  });

  it('keeps only the newest frames past the limit, as a fresh copy', () => {
    const frames = [1, 2, 3, 4].map((n) => ({ type: 'entry_appended', n }));
    expect(retainNewest(frames, 2)).toEqual(frames.slice(2));
    expect(retainNewest(frames, 10)).toEqual(frames);
    expect(retainNewest(frames, 10)).not.toBe(frames);
  });
});
