import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeWorkspaceMarker } from '@agimon-ai/doompi-core/history';
import { afterEach, describe, expect, it } from 'vitest';

import { checkoutWorkspaceId } from '../../src/builders/server/workspaceCheckout';

const directories: string[] = [];

function temporary(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-checkout-')));
  directories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function repository(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'file.txt'), 'one\n');
  git(root, 'add', 'file.txt');
  git(root, 'commit', '-q', '-m', 'init');
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('checkoutWorkspaceId', () => {
  it('accepts the workspace root, a subdirectory, and a worktree its git data names', () => {
    const base = temporary();
    const root = path.join(base, 'repo');
    repository(root);
    fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
    writeWorkspaceMarker(root, 'ws');
    const worktree = path.join(base, 'worktrees', 'feature');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', worktree);
    const records = [{ id: 'ws', root }];

    expect(checkoutWorkspaceId(records, root)).toBe('ws');
    expect(checkoutWorkspaceId(records, path.join(root, 'packages', 'app'))).toBe('ws');
    expect(checkoutWorkspaceId(records, worktree)).toBe('ws');
  });

  it('refuses an unrelated repository, a plain folder, and a workspace whose root is gone', () => {
    const base = temporary();
    const root = path.join(base, 'repo');
    repository(root);
    writeWorkspaceMarker(root, 'ws');
    const other = path.join(base, 'other');
    repository(other);
    const plain = path.join(base, 'plain');
    fs.mkdirSync(plain);

    expect(checkoutWorkspaceId([{ id: 'ws', root }], other)).toBeUndefined();
    expect(checkoutWorkspaceId([{ id: 'ws', root }], plain)).toBeUndefined();
    expect(checkoutWorkspaceId([{ id: 'ws', root: path.join(base, 'moved-away') }], root)).toBeUndefined();
  });
});
