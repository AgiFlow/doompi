import { describe, expect, it } from 'vitest';

import { groupByDirectory, groupRowLabel } from '../../src/exports';

interface Item {
  relPath: string;
}

const item = (relPath: string): Item => ({ relPath });
const group = (items: readonly Item[]) => groupByDirectory(items, (entry) => entry.relPath);

describe('groupByDirectory', () => {
  it('heads each group with the deepest directory its files share', () => {
    const groups = group([
      item('layers/source-control/doompi-git/package.json'),
      item('layers/source-control/doompi-git/src/exports/index.ts'),
      item('packages/clients/doompi-web/src/adapters/httpServer.ts'),
      item('packages/clients/doompi-web/src/adapters/sessionLineage.ts'),
    ]);

    expect(groups.map((entry) => entry.prefix)).toEqual([
      'layers/source-control/doompi-git',
      'packages/clients/doompi-web/src/adapters',
    ]);
  });

  it('orders groups and the files inside them by path, not by recency', () => {
    const groups = group([item('src/zebra.ts'), item('docs/guide.md'), item('src/alpha.ts')]);

    expect(groups.map((entry) => entry.prefix)).toEqual(['docs', 'src']);
    expect(groups[1].items.map((entry) => entry.relPath)).toEqual(['src/alpha.ts', 'src/zebra.ts']);
  });

  it('stops the shared header where the files diverge', () => {
    const [first] = group([item('src/a/b/one.ts'), item('src/a/c/two.ts')]);

    expect(first.prefix).toBe('src/a');
  });

  it('keeps repository-root files in an unheaded group that sorts first', () => {
    const groups = group([item('src/app.ts'), item('README.md')]);

    expect(groups.map((entry) => entry.prefix)).toEqual(['', 'src']);
    expect(groups[0].items.map((entry) => entry.relPath)).toEqual(['README.md']);
  });

  it('heads a single file with its own directory', () => {
    expect(group([item('docs/Third.md')])).toEqual([{ prefix: 'docs', items: [item('docs/Third.md')] }]);
  });

  it('returns nothing for an empty list', () => {
    expect(group([])).toEqual([]);
  });

  // The cockpit's Playwright suite drives this set through the file-edit
  // drawer and steps the cursor by index, so the row order is pinned here.
  it('puts the browser fixture in path order across both of its groups', () => {
    const groups = group([
      item('src/Newest.ts'),
      item('src/Second.ts'),
      item('docs/Third.md'),
      item('src/Fourth.ts'),
      item('src/Fifth.ts'),
      item('src/HiddenTarget.ts'),
    ]);

    expect(groups.flatMap((entry) => entry.items.map((row) => row.relPath))).toEqual([
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
