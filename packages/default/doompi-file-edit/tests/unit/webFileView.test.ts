import { buildReviewPrompt, type ReviewComment } from '@agimon-ai/doompi-web-components';
import { describe, expect, it } from 'vitest';

import {
  fileTabId,
  filterFileItems,
  previewModeOf,
  sendReviewFrame,
} from '../../src/extensions/workspaces/sessions/(frontend)/_lib/fileView';
import type { FilesItemView } from '../../src/types/webFiles';

const comment = (overrides: Partial<ReviewComment> = {}): ReviewComment => ({
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

describe('sendReviewFrame', () => {
  it('queues the review behind a running turn rather than prompting over it', () => {
    const comments = [comment({ startLine: 12 })];
    const frames: Record<string, unknown>[] = [];
    expect(sendReviewFrame((frame) => frames.push(frame), comments)).toBeUndefined();
    expect(frames).toEqual([{ type: 'enqueue_automatic', message: buildReviewPrompt(comments) }]);
  });

  it('hands back why the review did not leave, so the caller can keep the comments', () => {
    const failure = sendReviewFrame(() => {
      throw new Error('Session s1 is not connected.');
    }, [comment()]);
    expect(failure).toBe('Session s1 is not connected.');
  });
});
