import { beforeEach, describe, expect, it } from 'vitest';
import { fileLinks } from '../../src/web/fileLinks.ts';
import { files, filesChannel } from '../../src/web/filesStore.ts';

/**
 * What a message may link to.
 *
 * The rule is deliberately narrow: a path this session recorded a change to,
 * spelled the way the file list holds it. Everything else a message quotes in
 * backticks stays plain text, because a link that opens an error is worse than
 * no link.
 */

const SESSION = 's1';

const item = (relPath: string) => ({
  path: `/repo/${relPath}`,
  relPath,
  tool: 'edit' as const,
  at: 10,
  count: 1,
  diffable: true,
});

beforeEach(() => {
  files.reset();
  filesChannel.apply(SESSION, filesChannel.parse({ items: [item('src/app.ts'), item('docs/README.md')] })!);
});

describe('fileLinks', () => {
  it('opens the same tab the activity row does, by relative path', () => {
    const tab = fileLinks.resolve(SESSION, 'src/app.ts');
    expect(tab?.label).toBe('app.ts');
  });

  it('takes the absolute path the file list holds', () => {
    expect(fileLinks.resolve(SESSION, '/repo/docs/README.md')).toBeDefined();
  });

  it('drops a line reference before matching', () => {
    expect(fileLinks.resolve(SESSION, 'src/app.ts:42')).toBeDefined();
    expect(fileLinks.resolve(SESSION, 'src/app.ts:42:9')).toBeDefined();
  });

  it('refuses anything the session did not change', () => {
    expect(fileLinks.resolve(SESSION, 'src/other.ts')).toBeUndefined();
    expect(fileLinks.resolve(SESSION, 'flex gap-3')).toBeUndefined();
    expect(fileLinks.resolve(SESSION, '')).toBeUndefined();
  });

  it('refuses a session that changed nothing, and the unfocused page', () => {
    expect(fileLinks.resolve('s2', 'src/app.ts')).toBeUndefined();
    expect(fileLinks.resolve(null, 'src/app.ts')).toBeUndefined();
  });

  it('opens a changed file on its history when the caller is sure it is a path', () => {
    const tab = fileLinks.openPath?.(SESSION, 'src/app.ts');
    expect(tab?.id).toBe(fileLinks.resolve(SESSION, 'src/app.ts')?.id);
  });

  it('opens a file the session never changed read-only, which resolve refuses', () => {
    expect(fileLinks.resolve(SESSION, 'src/other.ts')).toBeUndefined();
    const tab = fileLinks.openPath?.(SESSION, '/repo/src/other.ts');
    expect(tab?.label).toBe('other.ts');
    expect(tab?.id.endsWith('-preview')).toBe(true);
  });

  it('has nothing to open for a call with no path', () => {
    expect(fileLinks.openPath?.(SESSION, '')).toBeUndefined();
    expect(fileLinks.openPath?.(SESSION, '   ')).toBeUndefined();
  });

  it('fingerprints the paths, so a swap at equal length still re-resolves', () => {
    const before = fileLinks.fingerprint(SESSION);
    filesChannel.apply(SESSION, filesChannel.parse({ items: [item('src/app.ts'), item('docs/CHANGES.md')] })!);
    expect(fileLinks.fingerprint(SESSION)).not.toBe(before);
  });

  it('notifies while the file list changes and stops on unsubscribe', () => {
    let seen = 0;
    const unsubscribe = fileLinks.subscribe(() => {
      seen += 1;
    });
    filesChannel.apply(SESSION, filesChannel.parse({ items: [item('src/app.ts')] })!);
    expect(seen).toBeGreaterThan(0);
    unsubscribe();
    const settled = seen;
    filesChannel.apply(SESSION, filesChannel.parse({ items: [] })!);
    expect(seen).toBe(settled);
  });
});
