import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBranchDiff, parseUnifiedDiff } from '../../src/services/branchDiff';
import { createGitSandbox, type GitSandbox } from '../support/gitSandbox';

let sandbox: GitSandbox;

beforeEach(() => {
  sandbox = createGitSandbox('doompi-git-diff-');
  // The service runs git with the hub's environment; point it at the sandbox's config.
  vi.stubEnv('GIT_CONFIG_GLOBAL', sandbox.env.GIT_CONFIG_GLOBAL!);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  sandbox.dispose();
});

describe('parseUnifiedDiff', () => {
  it('numbers context and additions on the new side and removals on the old', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -10,3 +10,4 @@ fn',
      ' keep',
      '-old',
      '+new',
      '+added',
      ' tail',
      '\\ No newline at end of file',
      '@@ -40 +41 @@',
      '-gone',
      '+here',
      '',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.binary).toBe(false);
    expect(parsed.rows).toBe(7);
    expect(parsed.hunks).toEqual([
      {
        start: 10,
        rows: [
          { marker: ' ', line: 10, content: 'keep' },
          { marker: '-', line: 11, content: 'old' },
          { marker: '+', line: 11, content: 'new' },
          { marker: '+', line: 12, content: 'added' },
          { marker: ' ', line: 13, content: 'tail' },
        ],
      },
      {
        start: 41,
        rows: [
          { marker: '-', line: 40, content: 'gone' },
          { marker: '+', line: 41, content: 'here' },
        ],
      },
    ]);
  });

  it('notices a binary diff', () => {
    expect(parseUnifiedDiff('diff --git a/p b/p\nBinary files a/p and b/p differ\n').binary).toBe(true);
  });
});

describe('branch review', () => {
  it('counts commits since the base plus staged, unstaged and untracked work', async () => {
    const repo = sandbox.repository('repo');
    sandbox.remote(repo, 'origin');
    sandbox.git(repo, 'checkout', '-q', '-b', 'feat/x');
    sandbox.commit(repo, 'src/a.ts', 'one\ntwo\n', 'branch work');
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\nstaged\n');
    sandbox.git(repo, 'add', 'README.md');
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'one\nTWO\n');
    fs.writeFileSync(path.join(repo, 'notes.md'), 'a\nb\nc');
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([1, 0, 2]));

    const review = await createBranchDiff().review(repo);
    expect(review?.changes).toMatchObject({
      branch: 'feat/x',
      base: 'origin/main',
      files: 4,
      added: 1 + 2 + 3,
      removed: 0,
    });
    expect(review?.summary.files.map((file) => [file.path, file.status])).toEqual([
      ['blob.bin', 'untracked'],
      ['notes.md', 'untracked'],
      ['README.md', 'modified'],
      ['src/a.ts', 'added'],
    ]);
    expect(review?.summary.files.find((file) => file.path === 'blob.bin')?.binary).toBe(true);
    expect(review?.summary.mergeBase).toMatch(/^[0-9a-f]{7}$/u);
  });

  it('draws tracked hunks against the merge base and untracked files as all added', async () => {
    const repo = sandbox.repository('repo');
    sandbox.remote(repo, 'origin');
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x\ny\n');
    const diff = createBranchDiff();
    const review = (await diff.review(repo))!;

    const readme = await diff.fileDiff(review, 'README.md');
    expect(readme.hunks[0]?.rows).toEqual([
      { marker: '-', line: 1, content: '# repo' },
      { marker: '+', line: 1, content: '# changed' },
    ]);
    const created = await diff.fileDiff(review, 'new.txt');
    expect(created.hunks).toEqual([
      {
        start: 1,
        rows: [
          { marker: '+', line: 1, content: 'x' },
          { marker: '+', line: 2, content: 'y' },
        ],
      },
    ]);
    await expect(diff.fileDiff(review, '../outside')).rejects.toThrow(/not in this review/u);
  });

  it('shows a symlink by its link text and never follows it', async () => {
    const repo = sandbox.repository('repo');
    const secret = path.join(sandbox.root, 'secret.txt');
    fs.writeFileSync(secret, 'top secret\n');
    fs.symlinkSync(secret, path.join(repo, 'link'));
    const diff = createBranchDiff();
    const review = (await diff.review(repo))!;
    const link = await diff.fileDiff(review, 'link');
    expect(JSON.stringify(link)).not.toContain('top secret');
    expect(link.hunks[0]?.rows[0]?.content).toBe(secret);
  });

  it("uses a worktree's recorded base, but not when that base is the branch itself", async () => {
    const repo = sandbox.repository('repo');
    sandbox.git(repo, 'branch', 'develop');
    sandbox.git(repo, 'checkout', '-q', '-b', 'feat/y');
    sandbox.commit(repo, 'y.txt', 'y\n', 'y');
    const diff = createBranchDiff();
    expect((await diff.review(repo, { recordedBaseRef: 'develop' }))?.changes).toMatchObject({
      base: 'develop',
      files: 1,
    });
    // No remote at all and the recorded base is the branch: only uncommitted work counts.
    expect((await diff.review(repo, { recordedBaseRef: 'feat/y' }))?.changes).toMatchObject({ files: 0 });
    expect((await diff.review(repo, { recordedBaseRef: 'feat/y' }))?.changes.base).toBeUndefined();
  });

  it.each(['main', 'wt/fix-auth'])(
    'reviews a linked worktree against recorded base %s, not its parent checkout',
    async (recordedBaseRef) => {
      const repo = sandbox.repository('repo');
      sandbox.remote(repo, 'origin');
      const checkout = path.join(sandbox.root, 'worktree');
      sandbox.git(repo, 'worktree', 'add', '-q', '-b', 'wt/fix-auth', checkout, 'main');
      sandbox.commit(checkout, 'committed.txt', 'committed\n', 'branch work');
      fs.writeFileSync(path.join(checkout, 'README.md'), '# child edit\n');
      sandbox.git(checkout, 'add', 'README.md');
      fs.writeFileSync(path.join(checkout, 'notes.txt'), 'child note\n');
      fs.writeFileSync(path.join(repo, 'parent-only.txt'), 'not in the worktree\n');

      const diff = createBranchDiff();
      const review = (await diff.review(checkout, { recordedBaseRef }))!;
      expect(review.changes).toMatchObject({
        branch: 'wt/fix-auth',
        base: 'origin/main',
        added: 3,
        removed: 1,
        files: 3,
      });
      expect(review.summary.files.map((file) => file.path)).toEqual(['committed.txt', 'notes.txt', 'README.md']);
      expect((await diff.fileDiff(review, 'README.md')).hunks[0]?.rows).toEqual([
        { marker: '-', line: 1, content: '# repo' },
        { marker: '+', line: 1, content: '# child edit' },
      ]);
    },
  );

  it('reports the upstream gap, and nothing outside a repository', async () => {
    const repo = sandbox.repository('repo');
    const remote = sandbox.remote(repo, 'origin');
    sandbox.commit(repo, 'ahead.txt', 'a\n', 'ahead');
    const other = sandbox.clone(remote, 'other');
    sandbox.commit(other, 'behind.txt', 'b\n', 'behind');
    sandbox.git(other, 'push', '-q');
    sandbox.git(repo, 'fetch', '-q');
    expect((await createBranchDiff().review(repo))?.changes.upstream).toEqual({
      ref: 'origin/main',
      ahead: 1,
      behind: 1,
    });

    const plain = path.join(sandbox.root, 'plain');
    fs.mkdirSync(plain);
    expect(await createBranchDiff().review(plain)).toBeUndefined();
  });
});
