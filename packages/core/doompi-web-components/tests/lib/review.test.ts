import { describe, expect, it } from 'vitest';

import {
  buildReviewPrompt,
  defaultReviewHeading,
  diffGutterWidth,
  diffRangeOf,
  type ReviewComment,
  reviewCommentAnchor,
  trimSnippet,
} from '../../src/exports';

const comment = (overrides: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 'c1',
  path: '/repo/src/app.ts',
  relPath: 'src/app.ts',
  snippet: 'const retries = 3;',
  body: 'this retry is unbounded',
  ...overrides,
});

describe('diffGutterWidth', () => {
  it('sizes to the widest line number a diff shows', () => {
    expect(
      diffGutterWidth([
        { start: 8, rows: [{ marker: ' ', line: 8, content: 'a' }] },
        { start: 1200, rows: [{ marker: '+', line: 1200, content: 'b' }] },
      ]),
    ).toBe(4);
  });

  it('never collapses to nothing for an empty diff', () => {
    expect(diffGutterWidth([])).toBe(1);
  });
});

describe('diffRangeOf', () => {
  it('puts context and added rows on the new side', () => {
    expect(
      diffRangeOf([
        { marker: ' ', line: 4 },
        { marker: '+', line: 5 },
        { marker: '+', line: 6 },
      ]),
    ).toEqual({ side: 'new', startLine: 4, endLine: 6 });
  });

  it('puts a selection made only of removed rows on the old side', () => {
    expect(
      diffRangeOf([
        { marker: '-', line: 30 },
        { marker: '-', line: 31 },
      ]),
    ).toEqual({ side: 'old', startLine: 30, endLine: 31 });
  });

  it('ignores removed rows in a mixed selection, since their numbers belong to the old file', () => {
    expect(
      diffRangeOf([
        { marker: ' ', line: 10 },
        { marker: '-', line: 90 },
        { marker: '+', line: 11 },
      ]),
    ).toEqual({ side: 'new', startLine: 10, endLine: 11 });
  });

  it('finds no range when no row carries a usable number', () => {
    expect(diffRangeOf([])).toBeUndefined();
    expect(diffRangeOf([{ marker: '+', line: 0 }])).toBeUndefined();
  });
});

describe('trimSnippet', () => {
  it('leaves a short snippet alone', () => {
    expect(trimSnippet('one\ntwo')).toBe('one\ntwo');
  });

  it('clips a long snippet by lines and marks the cut', () => {
    const trimmed = trimSnippet(Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n'), 5);
    expect(trimmed.split('\n')).toHaveLength(6);
    expect(trimmed.endsWith('…')).toBe(true);
  });

  it('clips a single enormous line by characters', () => {
    expect(trimSnippet('x'.repeat(5000), 20, 100)).toHaveLength(101);
  });
});

describe('reviewCommentAnchor', () => {
  it.each([
    ['a single new-side line', { startLine: 12, endLine: 12 }, 'src/app.ts:12'],
    ['a new-side range', { startLine: 12, endLine: 14 }, 'src/app.ts:12-14'],
    ['an explicit new side', { side: 'new' as const, startLine: 12, endLine: 14 }, 'src/app.ts:12-14'],
    ['a start with no end', { startLine: 12 }, 'src/app.ts:12'],
    ['no lines at all', {}, 'src/app.ts'],
    ['one removed line', { side: 'old' as const, startLine: 3, endLine: 3 }, 'src/app.ts (removed line 3)'],
    ['removed lines', { side: 'old' as const, startLine: 3, endLine: 4 }, 'src/app.ts (removed lines 3-4)'],
  ])('names %s', (_name, lines, expected) => {
    expect(reviewCommentAnchor(comment(lines))).toBe(expected);
  });
});

describe('buildReviewPrompt', () => {
  it('sends nothing when there is nothing to say', () => {
    expect(buildReviewPrompt([])).toBe('');
  });

  // The exact text the file-edit plugin sent before this moved here. Pinned
  // byte for byte so the move cannot change what an agent reads.
  it('keeps the default wording byte-identical to the file-edit review', () => {
    const prompt = buildReviewPrompt([
      comment({ id: 'c1', startLine: 12, endLine: 14, snippet: 'first\nsecond', body: '  this retry is unbounded \n' }),
      comment({ id: 'c2', relPath: 'src/router.ts', startLine: 40, body: 'rename to resolveHost' }),
      comment({ id: 'c3', relPath: 'README.md', snippet: 'rendered text', body: 'reword this' }),
    ]);
    expect(prompt).toBe(
      [
        'I left 3 review comments on files you changed. Please address them.',
        '',
        '### src/app.ts:12-14',
        '',
        '> first',
        '> second',
        '',
        'this retry is unbounded',
        '',
        '### src/router.ts:40',
        '',
        '> const retries = 3;',
        '',
        'rename to resolveHost',
        '',
        '### README.md',
        '',
        '> rendered text',
        '',
        'reword this',
      ].join('\n'),
    );
  });

  it('words one note in the singular', () => {
    expect(buildReviewPrompt([comment()])).toBe(
      'I left one review comment on a file you changed. Please address it.\n\n### src/app.ts\n\n> const retries = 3;\n\nthis retry is unbounded',
    );
    expect(defaultReviewHeading(1)).toContain('one review comment');
  });

  it('opens with a caller heading in place of the default', () => {
    const prompt = buildReviewPrompt([comment({ side: 'old', startLine: 3 })], 'Review of the staged diff.');
    expect(prompt).toBe(
      'Review of the staged diff.\n\n### src/app.ts (removed line 3)\n\n> const retries = 3;\n\nthis retry is unbounded',
    );
  });
});
