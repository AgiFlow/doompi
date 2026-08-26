import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchDirectoryTree } from '../../src/adapters/directorySearch.ts';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile,
}));

const roots: string[] = [];

afterEach(() => {
  execFile.mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fdResult(error: (Error & { code?: string | number }) | null, stdout: string): void {
  execFile.mockImplementationOnce(
    (
      _command: string,
      _args: string[],
      _options: object,
      callback: (error: (Error & { code?: string | number }) | null, stdout: string) => void,
    ) => {
      callback(error, stdout);
    },
  );
}

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-directory-search-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'project', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, '.secret'));
  fs.mkdirSync(path.join(root, 'node_modules', 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(root, 'file.txt'), 'not a directory');
  return root;
}

describe('directory tree search', () => {
  it('normalizes directory results returned by fd', async () => {
    fdResult(null, '/workspace/one/\n/workspace/two\n\n');

    await expect(searchDirectoryTree('/workspace', 'work')).resolves.toEqual(['/workspace/one', '/workspace/two']);
    expect(execFile).toHaveBeenCalledWith(
      'fd',
      expect.arrayContaining(['--type', 'd', '--max-depth', '6', '--', 'work', '/workspace']),
      expect.objectContaining({ timeout: 1500 }),
      expect.any(Function),
    );
  });

  it('treats fd exit code one as an empty result', async () => {
    fdResult(Object.assign(new Error('no matches'), { code: 1 }), '');

    await expect(searchDirectoryTree('/workspace', 'missing')).resolves.toEqual([]);
  });

  it('falls back to a bounded walk when fd is unavailable', async () => {
    const root = tree();
    fdResult(Object.assign(new Error('missing fd'), { code: 'ENOENT' }), '');

    const found = await searchDirectoryTree(root, 'project');

    expect(found).toContain(path.join(root, 'project'));
    expect(found).toContain(path.join(root, 'project', 'nested'));
    expect(found).not.toContain(path.join(root, '.secret'));
    expect(found).not.toContain(path.join(root, 'node_modules'));
  });

  it('includes hidden directories when the query asks for one', async () => {
    const root = tree();
    fdResult(Object.assign(new Error('missing fd'), { code: 'ENOENT' }), '');

    await expect(searchDirectoryTree(root, '.secret')).resolves.toContain(path.join(root, '.secret'));
  });

  it('returns no fallback results when the root cannot be read', async () => {
    fdResult(Object.assign(new Error('missing fd'), { code: 'ENOENT' }), '');

    await expect(searchDirectoryTree('/no/such/directory', 'project')).resolves.toEqual([]);
  });
});
