import { describe, expect, it } from 'vitest';
import type { FilesItemView } from '../../src/types/webFiles.ts';
import type { FileComment } from '../../src/web/lib/fileView.ts';
import {
  buildReviewPrompt,
  commentAnchor,
  fileTabId,
  filterFileItems,
  groupFileItems,
  groupRowLabel,
  gutterWidth,
  previewModeOf,
  trimSnippet,
} from '../../src/web/lib/fileView.ts';

const comment = (overrides: Partial<FileComment> = {}): FileComment => ({
  id: 'c1',
  path: '/repo/src/app.ts',
  relPath: 'src/app.ts',
  snippet: 'const retries = 3;',
  body: 'this retry is unbounded',
  ...overrides,
});

const fileItem = (relPath: string): FilesItemView => ({
  path: `/repo/${relPath}`,
  relPath,
  tool: 'edit',
  at: 10,
  count: 1,
  diffable: true,
});
describe('filterFileItems', () => {
  const items = [fileItem('src/Newest.ts'), fileItem('docs/Guide.md'), fileItem('src/oldest.test.ts')];

  it('returns every item in its original order for an empty query', () => {
    expect(filterFileItems(items, '  ')).toEqual(items);
  });

  it('matches relative paths case-insensitively, including later items', () => {
    expect(filterFileItems(items, 'OLDEST')).toEqual([items[2]]);
  });

  it('preserves newest-change order when several paths match', () => {
    expect(filterFileItems(items, 'sRc/')).toEqual([items[0], items[2]]);
  });
});

describe('groupFileItems', () => {
  it('heads each group with the deepest directory its files share', () => {
    const groups = groupFileItems([
      fileItem('layers/source-control/doompi-git/package.json'),
      fileItem('layers/source-control/doompi-git/src/exports/index.ts'),
      fileItem('packages/clients/doompi-web/src/adapters/httpServer.ts'),
      fileItem('packages/clients/doompi-web/src/adapters/sessionLineage.ts'),
    ]);

    expect(groups.map((group) => group.prefix)).toEqual([
      'layers/source-control/doompi-git',
      'packages/clients/doompi-web/src/adapters',
    ]);
  });

  it('orders groups and the files inside them by path, not by recency', () => {
    const groups = groupFileItems([fileItem('src/zebra.ts'), fileItem('docs/guide.md'), fileItem('src/alpha.ts')]);

    expect(groups.map((group) => group.prefix)).toEqual(['docs', 'src']);
    expect(groups[1].items.map((item) => item.relPath)).toEqual(['src/alpha.ts', 'src/zebra.ts']);
  });

  it('stops the shared header where the files diverge', () => {
    const [group] = groupFileItems([fileItem('src/a/b/one.ts'), fileItem('src/a/c/two.ts')]);

    expect(group.prefix).toBe('src/a');
  });

  it('keeps repository-root files in an unheaded group that sorts first', () => {
    const groups = groupFileItems([fileItem('src/app.ts'), fileItem('README.md')]);

    expect(groups.map((group) => group.prefix)).toEqual(['', 'src']);
    expect(groups[0].items.map((item) => item.relPath)).toEqual(['README.md']);
  });

  it('heads a single file with its own directory', () => {
    expect(groupFileItems([fileItem('docs/Third.md')])).toEqual([
      { prefix: 'docs', items: [fileItem('docs/Third.md')] },
    ]);
  });

  it('returns nothing for an empty list', () => {
    expect(groupFileItems([])).toEqual([]);
  });

  // The cockpit's Playwright suite drives this exact set and steps the cursor
  // by index, so the row order it will see is worth pinning here where the
  // failure is one line rather than a browser run.
  it('puts the browser fixture in path order across both of its groups', () => {
    const groups = groupFileItems([
      fileItem('src/Newest.ts'),
      fileItem('src/Second.ts'),
      fileItem('docs/Third.md'),
      fileItem('src/Fourth.ts'),
      fileItem('src/Fifth.ts'),
      fileItem('src/HiddenTarget.ts'),
    ]);

    expect(groups.flatMap((group) => group.items.map((item) => item.relPath))).toEqual([
      'docs/Third.md',
      'src/Fifth.ts',
      'src/Fourth.ts',
      'src/HiddenTarget.ts',
      'src/Newest.ts',
      'src/Second.ts',
    ]);
  });
});

describe('groupRowLabel', () => {
  it('drops the part the header already said', () => {
    expect(
      groupRowLabel('layers/source-control/doompi-git', 'layers/source-control/doompi-git/src/exports/index.ts'),
    ).toBe('src/exports/index.ts');
  });

  it('keeps the whole path for an unheaded root file', () => {
    expect(groupRowLabel('', 'README.md')).toBe('README.md');
  });
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
