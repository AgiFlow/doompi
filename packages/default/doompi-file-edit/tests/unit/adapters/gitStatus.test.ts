import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeGitStatusAdapter } from '../../../src/adapters/node/gitStatus.ts';

let root: string;
const adapter = new NodeGitStatusAdapter();

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function place(relative: string, content: string): string {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-git-status-')));
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  place('committed.txt', 'one\n');
  place('edited.txt', 'one\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'first');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('NodeGitStatusAdapter', () => {
  it('reports only the tracked paths whose content git says has not moved', async () => {
    const committed = path.join(root, 'committed.txt');
    const edited = place('edited.txt', 'one\ntwo\n');
    const untracked = place('temp.log', 'noise\n');

    expect(await adapter.unchanged(root, [committed, edited, untracked])).toEqual(new Set([committed]));
  });

  it('claims nothing about a tree that is not a repository', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-git-status-none-')));
    try {
      // No repository means no answer, so every candidate stays recordable.
      expect(await adapter.unchanged(outside, [place('committed.txt', 'one\n')])).toEqual(new Set());
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('claims nothing about a path outside the repository or an empty request', async () => {
    expect(await adapter.unchanged(root, [])).toEqual(new Set());
    expect(await adapter.unchanged(root, [path.join(os.tmpdir(), 'elsewhere.txt')])).toEqual(new Set());
  });
});
