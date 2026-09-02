import { describe, expect, it } from 'vitest';
import { hashlineGroups, hashlineGroupsKey } from '../../src/lib/hashlineHighlight.ts';
import type { PresentedLine } from '../../src/lib/hashlineView.ts';

const tagged = (line: number, content: string): PresentedLine => ({
  type: 'tagged',
  value: { line, content, marker: undefined },
});

describe('hashlineGroups', () => {
  it('gives a read body one run under the path the card knows', () => {
    const groups = hashlineGroups([tagged(1, 'const x = 1;'), tagged(2, 'export { x };')], 'src/a.ts');
    expect(groups).toEqual([{ path: 'src/a.ts', indices: [0, 1], text: 'const x = 1;\nexport { x };' }]);
  });

  it('cuts a grep body at every file heading, so each run parses as its own language', () => {
    const groups = hashlineGroups(
      [
        { type: 'file', path: 'src/a.ts' },
        tagged(1, 'const x = 1;'),
        { type: 'file', path: 'src/b.py' },
        tagged(9, 'x = 1'),
      ],
      undefined,
    );
    expect(groups).toEqual([
      { path: 'src/a.ts', indices: [1], text: 'const x = 1;' },
      { path: 'src/b.py', indices: [3], text: 'x = 1' },
    ]);
  });

  it('breaks a run at prose, which is not part of the file', () => {
    const groups = hashlineGroups([tagged(1, 'a'), { type: 'plain', text: '[2 more]' }, tagged(9, 'b')], 'x.ts');
    expect(groups.map((group) => group.indices)).toEqual([[0], [2]]);
  });

  it('has no runs for a body with no anchored lines', () => {
    expect(hashlineGroups([{ type: 'plain', text: 'no matches' }], 'x.ts')).toEqual([]);
  });
});

describe('hashlineGroupsKey', () => {
  it('changes when the text changes and holds when it does not', () => {
    const one = hashlineGroups([tagged(1, 'a')], 'x.ts');
    const same = hashlineGroups([tagged(1, 'a')], 'x.ts');
    const other = hashlineGroups([tagged(1, 'b')], 'x.ts');
    expect(hashlineGroupsKey(one)).toBe(hashlineGroupsKey(same));
    expect(hashlineGroupsKey(one)).not.toBe(hashlineGroupsKey(other));
  });
});
