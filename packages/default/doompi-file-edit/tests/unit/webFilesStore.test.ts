import { beforeEach, describe, expect, it } from 'vitest';
import type { FileEditsDetailView } from '../../src/types/fileEditsApi.ts';
import type { FilesPayload } from '../../src/web/filesStore.ts';
import {
  addComment,
  clearComments,
  files,
  filesChannel,
  markLoading,
  removeComment,
  storeDetail,
  storeError,
} from '../../src/web/filesStore.ts';

const item = (relPath: string, count = 1) => ({
  path: `/repo/${relPath}`,
  relPath,
  tool: 'edit' as const,
  at: 10,
  count,
  diffable: true,
});

const detailOf = (relPath: string): FileEditsDetailView => ({
  path: `/repo/${relPath}`,
  relPath,
  versions: [],
  cumulative: { additions: 0, removals: 0 },
  working: { content: '', hash: 'h', unavailable: false },
});

const session = (sessionId: string | null) => files.select(files.store.state, sessionId);

beforeEach(() => {
  files.reset();
});

describe('the files web store channel', () => {
  it('keeps each session separately and drops one with its session', () => {
    filesChannel.apply('s1', filesChannel.parse({ items: [item('a.ts')] })!);
    filesChannel.apply('s2', filesChannel.parse({ items: [] })!);
    expect(session('s1').items).toHaveLength(1);
    expect(session('s2').items).toEqual([]);
    expect(session(null).items).toEqual([]);

    filesChannel.drop('s1');
    expect(files.store.state.s1).toBeUndefined();
  });

  it.each([
    ['a payload that is not an object', 'junk'],
    ['a payload whose items are not a list', { items: 'no' }],
  ])('rejects %s at the parse gate', (_name, input) => {
    expect(filesChannel.parse(input)).toBeNull();
  });

  it('drops an item that is missing the fields a row needs', () => {
    // The contribution erases its payload type at the boundary, which is the
    // point of the gate: what comes back is only as good as what parse checked.
    const parsed = filesChannel.parse({ items: [item('a.ts'), { path: '/repo/b.ts' }] }) as FilesPayload | null;
    expect(parsed?.items).toHaveLength(1);
  });

  it('keeps the cached detail and pending notes of a file the list stopped reporting', () => {
    filesChannel.apply('s1', filesChannel.parse({ items: [item('a.ts'), item('b.ts')] })!);
    storeDetail('s1', detailOf('a.ts'));
    addComment('s1', { id: 'c1', path: '/repo/a.ts', relPath: 'a.ts', snippet: 'x', body: 'fix' });

    // Deleting a file drops it from the list. A tab open on it has to keep
    // working and say the file is gone, so its cache must survive the frame.
    filesChannel.apply('s1', filesChannel.parse({ items: [item('b.ts')] })!);
    expect(session('s1').items.map((entry) => entry.relPath)).toEqual(['b.ts']);
    expect(session('s1').detail['/repo/a.ts']?.relPath).toBe('a.ts');
    expect(session('s1').comments.map((comment) => comment.id)).toEqual(['c1']);
  });
});

describe('the files web store actions', () => {
  it('moves a file from loading to loaded, clearing any earlier error', () => {
    storeError('s1', '/repo/a.ts', 'unreachable');
    markLoading('s1', '/repo/a.ts');
    expect(session('s1').loading).toEqual(['/repo/a.ts']);
    expect(session('s1').errors['/repo/a.ts']).toBeUndefined();

    storeDetail('s1', detailOf('a.ts'));
    expect(session('s1').loading).toEqual([]);
    expect(session('s1').detail['/repo/a.ts']?.relPath).toBe('a.ts');
  });

  it('records a failed read against the file rather than losing it', () => {
    markLoading('s1', '/repo/a.ts');
    storeError('s1', '/repo/a.ts', 'The session is unreachable.');
    expect(session('s1').loading).toEqual([]);
    expect(session('s1').errors['/repo/a.ts']).toBe('The session is unreachable.');
  });

  it('does not queue the same file twice while one read is in flight', () => {
    markLoading('s1', '/repo/a.ts');
    markLoading('s1', '/repo/a.ts');
    expect(session('s1').loading).toEqual(['/repo/a.ts']);
  });

  it('adds, removes, and clears review notes per file', () => {
    addComment('s1', { id: 'c1', path: '/repo/a.ts', relPath: 'a.ts', snippet: 'x', body: 'one' });
    addComment('s1', { id: 'c2', path: '/repo/a.ts', relPath: 'a.ts', snippet: 'y', body: 'two' });
    addComment('s1', { id: 'c3', path: '/repo/b.ts', relPath: 'b.ts', snippet: 'z', body: 'three' });
    expect(session('s1').comments).toHaveLength(3);

    removeComment('s1', 'c1');
    expect(session('s1').comments.map((comment) => comment.id)).toEqual(['c2', 'c3']);

    // Sending a file's review clears that file's notes and leaves the others.
    clearComments('s1', '/repo/a.ts');
    expect(session('s1').comments.map((comment) => comment.id)).toEqual(['c3']);
  });
});
