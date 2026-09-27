import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSessionGitStatus } from '../../../../src/services/sessionGitStatus';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('readSessionGitStatus', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-git-status-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves undefined outside a git work tree', async () => {
    await expect(readSessionGitStatus(root)).resolves.toBeUndefined();
  });

  it('reads the branch and flips dirty only for tracked changes', async () => {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(root, 'file.txt'), 'one\n');
    git(root, 'add', 'file.txt');
    git(root, 'commit', '-q', '-m', 'init');

    await expect(readSessionGitStatus(root)).resolves.toEqual({ branch: 'main', dirty: false });

    fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n');
    await expect(readSessionGitStatus(root)).resolves.toEqual({ branch: 'main', dirty: false });

    fs.writeFileSync(path.join(root, 'file.txt'), 'two\n');
    await expect(readSessionGitStatus(root)).resolves.toEqual({ branch: 'main', dirty: true });
  });

  it('names a detached head by its short commit', async () => {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(root, 'file.txt'), 'one\n');
    git(root, 'add', 'file.txt');
    git(root, 'commit', '-q', '-m', 'init');
    const head = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '--detach');

    await expect(readSessionGitStatus(root)).resolves.toEqual({ branch: head.slice(0, 7), dirty: false });
  });
});
