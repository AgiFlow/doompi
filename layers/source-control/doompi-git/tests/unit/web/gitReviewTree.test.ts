import { describe, expect, it } from 'vitest';

import { flattenTree } from '../../../src/extensions/workspaces/sessions/(frontend)/_lib/gitReviewTree';

const file = (path: string) => ({ path, status: 'modified' as const, added: 1, removed: 0 });
const files = [
  file('packages/clients/doompi-web/src/a.ts'),
  file('packages/clients/doompi-web/tests/b.test.ts'),
  file('README.md'),
  file('layers/template/x.ts'),
];
const label = (row: ReturnType<typeof flattenTree>[number]) =>
  `${'  '.repeat(row.depth)}${row.kind === 'dir' ? `${row.name}/` : row.file.path.split('/').pop()}`;

describe('review file tree', () => {
  it('nests folders first, compacts single-child chains, files last', () => {
    expect(flattenTree(files, () => true).map(label)).toEqual([
      'layers/template/',
      '  x.ts',
      'packages/clients/doompi-web/',
      '  src/',
      '    a.ts',
      '  tests/',
      '    b.test.ts',
      'README.md',
    ]);
  });

  it('hides the contents of a collapsed folder', () => {
    const rows = flattenTree(files, (dir) => dir !== 'packages/clients/doompi-web');
    expect(rows.map(label)).toEqual(['layers/template/', '  x.ts', 'packages/clients/doompi-web/', 'README.md']);
  });
});
