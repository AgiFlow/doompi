import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDirectories, splitDirectoryQuery, suggestDirectories } from '../../src/adapters/directoryListing.ts';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-dirs-'));
  for (const name of ['alpha', 'beta-app', 'beta-lib', '.hidden', 'x[1]']) {
    fs.mkdirSync(path.join(workDir, name));
  }
  fs.writeFileSync(path.join(workDir, 'notes.txt'), '');
  fs.symlinkSync(path.join(workDir, 'alpha'), path.join(workDir, 'linked'));
  fs.symlinkSync(path.join(workDir, 'gone'), path.join(workDir, 'dangling'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('splitDirectoryQuery', () => {
  it('splits at the last slash and treats the root as its own parent', () => {
    expect(splitDirectoryQuery('/Users/me/work')).toEqual({ parent: '/Users/me', pattern: 'work' });
    expect(splitDirectoryQuery('/Users/me/')).toEqual({ parent: '/Users/me', pattern: '' });
    expect(splitDirectoryQuery('/Us')).toEqual({ parent: '/', pattern: 'Us' });
    expect(splitDirectoryQuery('/')).toEqual({ parent: '/', pattern: '' });
  });

  it('rejects relative paths, which a session would reject too', () => {
    expect(splitDirectoryQuery('work/app')).toBeUndefined();
    expect(splitDirectoryQuery('')).toBeUndefined();
  });
});

describe('listDirectories', () => {
  it('lists child directories, following links and leaving files and dotdirs out', async () => {
    const listed = await listDirectories(`${workDir}/`);
    expect(listed).toEqual(['alpha', 'beta-app', 'beta-lib', 'linked', 'x[1]'].map((name) => path.join(workDir, name)));
  });

  it('filters children by the trailing segment as a case-insensitive regex', async () => {
    expect(await listDirectories(`${workDir}/^BETA`)).toEqual(
      ['beta-app', 'beta-lib'].map((name) => path.join(workDir, name)),
    );
    expect(await listDirectories(`${workDir}/lib$`)).toEqual([path.join(workDir, 'beta-lib')]);
  });

  it('falls back to substring matching while a regex is still being typed', async () => {
    expect(await listDirectories(`${workDir}/x[`)).toEqual([path.join(workDir, 'x[1]')]);
  });

  it('shows hidden directories once the pattern asks for them', async () => {
    // A bare dot is still a regex: it also matches the "ph" in alpha.
    expect(await listDirectories(`${workDir}/.h`)).toEqual(
      ['.hidden', 'alpha'].map((name) => path.join(workDir, name)),
    );
    expect(await listDirectories(`${workDir}/^\\.h`)).toEqual([path.join(workDir, '.hidden')]);
    expect(await listDirectories(`${workDir}/h`)).toEqual([path.join(workDir, 'alpha')]);
  });

  it('honours the limit', async () => {
    expect(await listDirectories(`${workDir}/`, 2)).toEqual(
      ['alpha', 'beta-app'].map((name) => path.join(workDir, name)),
    );
  });

  it('yields nothing for relative paths and unreadable parents', async () => {
    expect(await listDirectories('relative/path')).toEqual([]);
    expect(await listDirectories(`${workDir}/missing/child`)).toEqual([]);
  });
});

describe('suggestDirectories', () => {
  it('completes a path that is being drilled into, without searching', async () => {
    let searched = false;
    const suggestions = await suggestDirectories(path.join(workDir, 'al'), {
      homeDirectory: workDir,
      search: async () => {
        searched = true;
        return [];
      },
    });

    expect(suggestions).toEqual([path.join(workDir, 'alpha')]);
    expect(searched).toBe(false);
  });

  it('searches for the folder a path from another machine names', async () => {
    // The parent does not exist here, so the trailing segment is the query.
    const suggestions = await suggestDirectories('/home/someone-else/projects/alpha', {
      homeDirectory: workDir,
      search: (_root, query) => Promise.resolve(query === 'alpha' ? [path.join(workDir, 'alpha')] : []),
    });

    expect(suggestions).toEqual([path.join(workDir, 'alpha')]);
  });

  it('searches for a bare folder name, ranked and capped', async () => {
    const suggestions = await suggestDirectories('alpha', {
      limit: 1,
      homeDirectory: workDir,
      search: () => Promise.resolve([path.join(workDir, 'deep', 'nested', 'alpha'), path.join(workDir, 'alpha')]),
    });

    // The shallow one is what anyone meant.
    expect(suggestions).toEqual([path.join(workDir, 'alpha')]);
  });

  it('offers nothing for an empty value, and survives a search that throws', async () => {
    expect(await suggestDirectories('   ', { homeDirectory: workDir, search: () => Promise.resolve([]) })).toEqual([]);
    expect(
      await suggestDirectories('nowhere-at-all', {
        homeDirectory: workDir,
        search: () => Promise.reject(new Error('no such root')),
      }),
    ).toEqual([]);
  });
});

describe('pinning suggestions to one subtree', () => {
  /**
   * What a paired device is allowed to see.
   *
   * Answering from the whole home directory hands it a map of the machine, so
   * while a tunnel is up the picker is pinned to the directory the cockpit was
   * started from.
   */
  it('lists children of a directory inside the root', async () => {
    expect(await listDirectories(`${workDir}/alph`, 12, workDir)).toEqual([path.join(workDir, 'alpha')]);
  });

  it('lists nothing for a parent outside the root, rather than filtering its children', async () => {
    // Filtering after listing would still confirm what is in there through
    // timing and through an empty answer meaning something different.
    expect(await listDirectories('/', 12, workDir)).toEqual([]);
  });

  it('refuses a parent that only looks like the root', async () => {
    expect(await listDirectories(`${workDir}-other/`, 12, workDir)).toEqual([]);
  });

  it('still lists the root itself', async () => {
    expect(await listDirectories(`${workDir}/`, 12, workDir)).not.toEqual([]);
  });

  it('searches the root instead of home when one is set', async () => {
    const roots: string[] = [];
    await suggestDirectories('alpha', {
      homeDirectory: '/somewhere/else',
      root: workDir,
      search: (root) => {
        roots.push(root);
        return Promise.resolve([]);
      },
    });
    expect(roots).toEqual([workDir]);
  });

  it('drops a search result from outside the root, whatever the search returned', async () => {
    const suggestions = await suggestDirectories('alpha', {
      homeDirectory: workDir,
      root: path.join(workDir, 'beta-app'),
      search: () => Promise.resolve([path.join(workDir, 'alpha'), path.join(workDir, 'beta-app', 'alpha')]),
    });
    expect(suggestions).toEqual([path.join(workDir, 'beta-app', 'alpha')]);
  });

  it('searches home when no root is set, which is the local case', async () => {
    const roots: string[] = [];
    await suggestDirectories('alpha', {
      homeDirectory: workDir,
      search: (root) => {
        roots.push(root);
        return Promise.resolve([]);
      },
    });
    expect(roots).toEqual([workDir]);
  });
});
