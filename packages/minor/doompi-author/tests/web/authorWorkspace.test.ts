import { afterEach, describe, expect, it } from 'vitest';
import { boundedCaptureContext } from '../../src/web/authorCapture.ts';
import {
  addAuthorAnnotation,
  authorDocument,
  authorWorkspace,
  completeAuthorSave,
  dropAuthorSession,
  normalizeAuthorPath,
  putAuthorDocument,
  requestAuthorSave,
  reviseAuthorDocument,
  reviseAuthorFragment,
} from '../../src/web/authorWorkspaceStore.ts';

afterEach(() => authorWorkspace.reset());

describe('Author workspace store', () => {
  it('keys ephemeral drafts by session and normalized path', () => {
    expect(normalizeAuthorPath(' ./docs/../README.md ')).toBe('README.md');
    putAuthorDocument('s1', { path: './docs/../README.md', kind: 'markdown', content: 'one' });
    putAuthorDocument('s2', { path: 'README.md', kind: 'markdown', content: 'other' });
    reviseAuthorDocument('s1', 'README.md', 'two');
    requestAuthorSave('s1', 'README.md');
    addAuthorAnnotation('s1', 'README.md', { id: 'a1', kind: 'comment', body: 'check this' });

    expect(authorDocument('s1', 'README.md')).toMatchObject({ content: 'two', saveRequest: 1 });
    expect(authorDocument('s1', 'README.md')?.revisions).toEqual([{ revision: 1, content: 'two' }]);
    expect(authorDocument('s2', 'README.md')?.content).toBe('other');
    dropAuthorSession('s1');
    expect(authorDocument('s1', 'README.md')).toBeUndefined();
    expect(authorDocument('s2', 'README.md')).toBeDefined();
  });

  it('keeps edits made during an in-flight save dirty while advancing the saved source', async () => {
    putAuthorDocument('s1', {
      path: 'report.csv',
      kind: 'csv',
      sourceSha256: 'a'.repeat(64),
      fragments: [{ id: 'cell:1:1', kind: 'cell', location: 'A1', text: 'zero' }],
      originalFragments: [{ id: 'cell:1:1', kind: 'cell', location: 'A1', text: 'zero' }],
    });
    reviseAuthorFragment('s1', 'report.csv', 'cell:1:1', 'one');
    const saved = authorDocument('s1', 'report.csv')!;
    let resolveSave!: (sha256: string) => void;
    const pendingSave = new Promise<string>((resolve) => {
      resolveSave = resolve;
    });
    const completion = pendingSave.then((sha256) =>
      completeAuthorSave('s1', 'report.csv', sha256, saved.version, saved.fragments),
    );

    reviseAuthorFragment('s1', 'report.csv', 'cell:1:1', 'two');
    resolveSave('b'.repeat(64));
    await completion;

    expect(authorDocument('s1', 'report.csv')).toMatchObject({
      sourceSha256: 'b'.repeat(64),
      savedVersion: saved.version,
      revisions: [{ revision: 2, content: 'two' }],
      fragments: [{ id: 'cell:1:1', kind: 'cell', location: 'A1', text: 'two' }],
    });
    expect(authorDocument('s1', 'report.csv')?.originalFragments).toEqual(saved.fragments);
  });

  it('bounds capture semantic context to 8 KiB', () => {
    const bounded = boundedCaptureContext({
      kind: 'author-viewport',
      source: 'author',
      id: 's1:file',
      label: 'file',
      content: 'é'.repeat(10_000),
    });
    expect(new TextEncoder().encode(bounded.content).byteLength).toBeLessThanOrEqual(8 * 1024);
  });
});
