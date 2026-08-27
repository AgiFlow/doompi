import { describe, expect, it } from 'vitest';
import type { FileComment } from '../../web/filesStore.ts';
import {
  buildReviewPrompt,
  commentAnchor,
  fileTabId,
  gutterWidth,
  previewModeOf,
  trimSnippet,
} from '../../web/fileView.ts';

const comment = (overrides: Partial<FileComment> = {}): FileComment => ({
  id: 'c1',
  path: '/repo/src/app.ts',
  relPath: 'src/app.ts',
  snippet: 'const retries = 3;',
  body: 'this retry is unbounded',
  ...overrides,
});

describe('previewModeOf', () => {
  it.each([
    ['README.md', 'markdown'],
    ['NOTES.MARKDOWN', 'markdown'],
    ['page.html', 'html'],
    ['page.HTM', 'html'],
    ['src/app.ts', 'code'],
    ['fix.sh', 'code'],
    ['Dockerfile', 'code'],
    ['docs/report.pdf', 'media'],
    ['shot.png', 'media'],
    ['clip.mp4', 'media'],
    ['LICENSE', 'text'],
    ['notes.txt', 'text'],
  ])('shows %s as %s', (filePath, expected) => {
    expect(previewModeOf(filePath, false)).toBe(expected);
  });

  it('shows the bytes of a file it cannot read as text, rather than an apology', () => {
    // The snapshot store refuses a PNG as binary, which is exactly the file a
    // reader most wants to look at.
    expect(previewModeOf('shot.png', true)).toBe('media');
    expect(previewModeOf('docs/report.pdf', true)).toBe('media');
  });

  it('falls back to saying why only when there is nothing to render', () => {
    expect(previewModeOf('notes/minutes.docx', true)).toBe('unavailable');
    expect(previewModeOf('src/app.ts', true)).toBe('unavailable');
  });
});

describe('fileTabId', () => {
  it('is stable for one path, so reopening focuses rather than duplicating', () => {
    expect(fileTabId('/repo/src/app.ts')).toBe(fileTabId('/repo/src/app.ts'));
  });

  it('separates two files whose names end the same way', () => {
    // The id keeps only the tail of the path, so the fingerprint is what has to
    // tell these apart.
    expect(fileTabId('/repo/a/index.ts')).not.toBe(fileTabId('/repo/b/index.ts'));
  });

  it('carries nothing a URL segment cannot hold', () => {
    expect(fileTabId('/repo/we ird/naME(1).ts')).toMatch(/^[a-zA-Z0-9-]+$/u);
  });
});

describe('gutterWidth', () => {
  it('sizes to the widest line number a diff shows', () => {
    expect(
      gutterWidth([
        { start: 8, rows: [{ marker: ' ', line: 8, content: 'a' }] },
        { start: 1200, rows: [{ marker: '+', line: 1200, content: 'b' }] },
      ]),
    ).toBe(4);
  });

  it('never collapses to nothing for an empty diff', () => {
    expect(gutterWidth([])).toBe(1);
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

describe('commentAnchor', () => {
  it.each([
    ['a single line', { startLine: 12, endLine: 12 }, 'src/app.ts:12'],
    ['a range', { startLine: 12, endLine: 14 }, 'src/app.ts:12-14'],
    ['a start with no end', { startLine: 12 }, 'src/app.ts:12'],
    ['no lines at all', {}, 'src/app.ts'],
  ])('names %s', (_name, lines, expected) => {
    expect(commentAnchor(comment(lines))).toBe(expected);
  });
});

describe('buildReviewPrompt', () => {
  it('sends nothing when there is nothing to say', () => {
    expect(buildReviewPrompt([])).toBe('');
  });

  it('puts every note in one message, each with its anchor and quotation', () => {
    const prompt = buildReviewPrompt([
      comment({ id: 'c1', startLine: 12, endLine: 14 }),
      comment({ id: 'c2', relPath: 'src/router.ts', startLine: 40, body: 'rename to resolveHost' }),
    ]);
    expect(prompt).toContain('2 review comments');
    expect(prompt).toContain('### src/app.ts:12-14');
    expect(prompt).toContain('### src/router.ts:40');
    expect(prompt).toContain('> const retries = 3;');
    expect(prompt).toContain('rename to resolveHost');
  });

  it('words one note in the singular', () => {
    expect(buildReviewPrompt([comment()])).toContain('one review comment');
  });

  it('quotes every line of a multi-line selection', () => {
    const prompt = buildReviewPrompt([comment({ snippet: 'first\nsecond' })]);
    expect(prompt).toContain('> first\n> second');
  });
});
