import { describe, expect, it } from 'vitest';
import { rankDirectories, scoreDirectory, searchTermFor } from '../../src/services/directoryMatch.ts';

describe('scoreDirectory', () => {
  it('ranks a folder by how directly its own name answers the query', () => {
    const exact = scoreDirectory('/Users/me/work/api', 'api');
    const prefix = scoreDirectory('/Users/me/work/api-server', 'api');
    const contains = scoreDirectory('/Users/me/work/legacy-api', 'api');
    const inPath = scoreDirectory('/Users/me/api/frontend', 'api');

    expect(exact).toBeGreaterThan(prefix!);
    expect(prefix).toBeGreaterThan(contains!);
    expect(contains).toBeGreaterThan(inPath!);
  });

  it('prefers the shallow answer when the name matches equally well', () => {
    const shallow = scoreDirectory('/Users/me/api', 'api');
    const deep = scoreDirectory('/Users/me/work/vendor/bundled/api', 'api');
    expect(shallow).toBeGreaterThan(deep!);
  });

  it('matches without regard to case, and refuses what does not match at all', () => {
    expect(scoreDirectory('/Users/me/AgiRepo', 'agirepo')).toBeDefined();
    expect(scoreDirectory('/Users/me/work/api', 'ledger')).toBeUndefined();
    expect(scoreDirectory('/Users/me/work/api', '   ')).toBeUndefined();
  });
});

describe('rankDirectories', () => {
  it('orders by score, breaks ties by path, dedupes, and honours the limit', () => {
    const ranked = rankDirectories(
      [
        '/Users/me/work/legacy-api',
        '/Users/me/work/api',
        '/Users/me/work/api',
        '/Users/me/work/api-server',
        '/Users/me/notes',
      ],
      'api',
      2,
    );
    expect(ranked).toEqual(['/Users/me/work/api', '/Users/me/work/api-server']);
  });

  it('yields nothing when nothing matches', () => {
    expect(rankDirectories(['/Users/me/notes'], 'api', 5)).toEqual([]);
  });
});

describe('searchTermFor', () => {
  it('takes the last segment, because that is the folder someone means', () => {
    // A path remembered from another machine still names the right folder.
    expect(searchTermFor('/home/workspaces/agirepo')).toBe('agirepo');
    expect(searchTermFor('agirepo')).toBe('agirepo');
    expect(searchTermFor('/Users/me/work/')).toBe('work');
    expect(searchTermFor('   ')).toBe('');
    expect(searchTermFor('/')).toBe('');
  });
});
