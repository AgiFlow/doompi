import { describe, expect, it } from 'vitest';
import {
  LIST_COLLAPSED_LINES,
  WRITE_COLLAPSED_LINES,
  findCallView,
  formatSize,
  listResultView,
  lsCallView,
  resultText,
  writeCallView,
} from '../web/builtinToolView.ts';

const text = (value: string, details?: unknown) => ({ content: [{ type: 'text', text: value }], details });

describe('the write call view', () => {
  it('shows the path, the size, and a numbered preview collapsed to ten lines', () => {
    const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
    const collapsed = writeCallView({ path: 'a.ts', content }, false);
    expect(collapsed).toMatchObject({ path: 'a.ts', size: '86 chars', hidden: 2, gutter: 2 });
    expect(collapsed.preview).toHaveLength(WRITE_COLLAPSED_LINES);
    expect(collapsed.preview[0]).toEqual({ number: 1, text: 'line 1' });
    expect(writeCallView({ path: 'a.ts', content }, true)).toMatchObject({ hidden: 0 });
    expect(writeCallView({ path: 'a.ts', content: 'x\ty\r\n\n' }, false).preview).toEqual([
      { number: 1, text: 'x  y' },
    ]);
    expect(writeCallView({ path: 'a.ts', content: '' }, false)).toEqual({
      path: 'a.ts',
      size: '0 chars',
      preview: [],
      hidden: 0,
      gutter: 1,
    });
    expect(writeCallView({}, false).path).toBe('');
  });
});

describe('the find and ls call views', () => {
  it('list the pattern or path with the limit the way the TUI headings do', () => {
    expect(findCallView({ pattern: '*.ts', path: 'src', limit: 5 })).toEqual({
      primary: '*.ts',
      details: ['src', '5 results'],
    });
    expect(findCallView({})).toEqual({ primary: '', details: ['.'] });
    expect(lsCallView({ path: 'src', limit: 3 })).toEqual({ primary: 'src', details: ['3 entries'] });
    expect(lsCallView({})).toEqual({ primary: '.', details: [] });
  });
});

describe('the listing result view', () => {
  it('collapses to twenty lines and names the limits the details carry', () => {
    const listing = Array.from({ length: 25 }, (_, index) => `entry-${index}`).join('\n');
    const collapsed = listResultView(
      text(listing, { entryLimitReached: 25 }),
      '',
      false,
      'entryLimitReached',
      'entries',
    );
    expect(collapsed.lines).toHaveLength(LIST_COLLAPSED_LINES);
    expect(collapsed.hidden).toBe(5);
    expect(collapsed.truncated).toBe('[Truncated: 25 entries limit]');
    expect(listResultView(text(listing), '', true, 'entryLimitReached', 'entries')).toMatchObject({
      hidden: 0,
      truncated: undefined,
    });
    expect(
      listResultView(text('a', { truncation: { truncated: true } }), '', false, 'resultLimitReached', 'results')
        .truncated,
    ).toBe('[Truncated: 50.0KB limit]');
    expect(
      listResultView(
        text('a', { resultLimitReached: 2, truncation: { truncated: true, maxBytes: 2048 } }),
        '',
        false,
        'resultLimitReached',
        'results',
      ).truncated,
    ).toBe('[Truncated: 2 results limit, 2.0KB limit]');
    expect(listResultView(null, ' \n', false, 'x', 'x')).toEqual({ lines: [], hidden: 0, truncated: undefined });
  });

  it('reads text blocks only and falls back to the joined output', () => {
    expect(
      resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, 'junk'], details: undefined }, ''),
    ).toBe('a');
    expect(resultText(null, 'out')).toBe('out');
  });

  it('formats sizes like Pi', () => {
    expect(formatSize(512)).toBe('512B');
    expect(formatSize(2048)).toBe('2.0KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0MB');
  });
});
