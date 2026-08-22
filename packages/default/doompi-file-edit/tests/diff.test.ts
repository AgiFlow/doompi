import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitDiffService, MAX_DIFF_LINES } from '../src/adapters/GitDiffService/GitDiffService.ts';

let repository: string;
const service = new GitDiffService();

function write(name: string, content: string | Buffer): string {
  const filePath = path.join(repository, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

beforeEach(() => {
  repository = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-git-'));
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
  write('tracked.txt', 'before\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repository });
});

afterEach(() => fs.rmSync(repository, { recursive: true, force: true }));

describe('GitDiffService', () => {
  it('diffs a tracked file against HEAD', async () => {
    const filePath = write('tracked.txt', 'after\nsecond\n');
    const diff = await service.diff(repository, filePath);
    expect(diff).toMatchObject({ tracked: true, state: 'modified', additions: 2, removals: 1 });
  });

  it('renders an untracked file as a full add', async () => {
    const diff = await service.diff(repository, write('new.txt', 'one\ntwo\n'));
    expect(diff).toMatchObject({ tracked: false, state: 'added' });
    expect(diff.lines).toContain('+one');
  });

  it('truncates before returning an oversized diff', async () => {
    const content = Array.from({ length: MAX_DIFF_LINES + 50 }, (_, index) => `line ${index}`).join('\n');
    const diff = await service.diff(repository, write('large.txt', content));
    expect(diff.truncated).toBe(true);
    expect(diff.lines.at(-1)).toContain('diff truncated');
    expect(diff.lines.length).toBeLessThanOrEqual(MAX_DIFF_LINES + 1);
  });

  it('summarizes an untracked binary file without returning bytes', async () => {
    const diff = await service.diff(repository, write('binary.bin', Buffer.from([0, 1, 2, 3])));
    expect(diff.state).toBe('binary');
    expect(diff.lines.join(' ')).toContain('Binary');
  });

  it('summarizes a tracked binary change without returning bytes', async () => {
    write('tracked.bin', Buffer.from([0, 1, 2, 3]));
    execFileSync('git', ['add', 'tracked.bin'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'binary fixture'], { cwd: repository });
    const diff = await service.diff(repository, write('tracked.bin', Buffer.from([0, 4, 5, 6])));
    expect(diff).toMatchObject({ state: 'binary', tracked: true, additions: 0, removals: 0 });
    expect(diff.lines).toEqual(['Binary tracked file changed']);
  });

  it('renders a deleted tracked file as a full removal', async () => {
    const filePath = path.join(repository, 'tracked.txt');
    fs.unlinkSync(filePath);
    const diff = await service.diff(repository, filePath);
    expect(diff).toMatchObject({ tracked: true, state: 'deleted', removals: 1 });
  });
});
