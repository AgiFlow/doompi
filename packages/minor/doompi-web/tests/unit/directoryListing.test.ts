import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDirectories, splitDirectoryQuery } from '../../src/adapters/directoryListing.ts';

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
