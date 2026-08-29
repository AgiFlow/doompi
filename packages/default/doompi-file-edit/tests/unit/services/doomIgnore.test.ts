import { describe, expect, it } from 'vitest';
import { filterDoomIgnoredFiles } from '../../../src/services/doomIgnore.ts';
import type { FilesItemView } from '../../../src/types/webFiles.ts';

function item(relPath: string): FilesItemView {
  return { path: `/work/${relPath}`, relPath, tool: 'edit', at: 1, count: 1, diffable: true };
}

describe('filterDoomIgnoredFiles', () => {
  it('leaves the ordered list unchanged for empty rules, comments, and blank lines', () => {
    const items = [item('new.ts'), item('older.ts')];
    expect(filterDoomIgnoredFiles(items, '')).toBe(items);
    expect(filterDoomIgnoredFiles(items, '  \n\t')).toBe(items);
    expect(filterDoomIgnoredFiles(items, '# generated files\n\n')).toEqual(items);
  });

  it('applies file, directory, and ordered negation rules', () => {
    const items = [item('generated.log'), item('dist/nested/a.ts'), item('keep.log'), item('src/a.ts')];
    expect(filterDoomIgnoredFiles(items, '*.log\n!keep.log\ndist/\n').map((row) => row.relPath)).toEqual([
      'keep.log',
      'src/a.ts',
    ]);
  });

  it('normalizes Windows separators before matching', () => {
    const items = [item('src\\generated\\a.ts'), item('src\\kept.ts')];
    expect(filterDoomIgnoredFiles(items, 'src/generated/\n').map((row) => row.relPath)).toEqual(['src\\kept.ts']);
  });

  it('keeps candidates outside the working directory or invalid for matching', () => {
    const items = [item('../outside.log'), item('/absolute.log'), item('bad\0name.log'), item('inside.log')];
    expect(filterDoomIgnoredFiles(items, '*.log\n').map((row) => row.relPath)).toEqual([
      '../outside.log',
      '/absolute.log',
      'bad\0name.log',
    ]);
  });

  it('returns the original list when matcher setup fails unexpectedly', () => {
    const items = [item('generated.log')];
    expect(filterDoomIgnoredFiles(items, null as unknown as string)).toBe(items);
  });
});
