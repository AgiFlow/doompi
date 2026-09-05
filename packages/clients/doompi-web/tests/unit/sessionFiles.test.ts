import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSessionFiles, readSessionFile, writeSessionFile } from '../../src/adapters/sessionFiles.ts';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-files-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function write(relative: string): void {
  const full = path.join(workDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '');
}

describe('listSessionFiles', () => {
  it('walks a plain directory, skipping generated trees and dotfiles except .doom', async () => {
    write('src/app.ts');
    write('node_modules/dep/index.js');
    write('dist/out.js');
    write('.hidden/secret.txt');
    write('.doom/config.yaml');
    write('README.md');

    const files = await listSessionFiles(workDir, '', 20);
    expect(files).toContain('src/app.ts');
    expect(files).toContain('README.md');
    expect(files).toContain('.doom/config.yaml');
    expect(files.some((file) => file.includes('node_modules'))).toBe(false);
    expect(files.some((file) => file.includes('dist/'))).toBe(false);
    expect(files.some((file) => file.includes('.hidden'))).toBe(false);
  });

  it('uses the git index when the directory is a repository', async () => {
    execFileSync('git', ['init', '-q'], { cwd: workDir });
    write('kept.ts');
    write('ignored.txt');
    fs.writeFileSync(path.join(workDir, '.gitignore'), 'ignored.txt\n');

    const files = await listSessionFiles(workDir, '', 20);
    expect(files).toContain('kept.ts');
    expect(files).toContain('.gitignore');
    expect(files).not.toContain('ignored.txt');
  });

  it('ranks and limits results by the query', async () => {
    write('src/gateKeeper.ts');
    write('notes/gate.md');
    write('other.txt');

    const files = await listSessionFiles(workDir, 'gate', 1);
    expect(files).toEqual(['notes/gate.md']);
  });
});

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('session file IO', () => {
  it('reads the body with its full SHA-256 digest', async () => {
    fs.writeFileSync(path.join(workDir, 'note.txt'), 'before');

    await expect(readSessionFile(workDir, 'note.txt', 100)).resolves.toEqual({
      status: 'ok',
      body: Buffer.from('before'),
      sha256: sha256('before'),
    });
  });

  it('atomically replaces the expected regular file and cleans its temporary file', async () => {
    fs.writeFileSync(path.join(workDir, 'note.txt'), 'before');

    await expect(
      writeSessionFile(workDir, 'note.txt', Buffer.from('after'), sha256('before'), 100, () => true),
    ).resolves.toEqual({ status: 'ok', sha256: sha256('after') });
    expect(fs.readFileSync(path.join(workDir, 'note.txt'), 'utf8')).toBe('after');
    expect(fs.readdirSync(workDir)).toEqual(['note.txt']);
  });

  it('preserves a concurrently changed file and refuses final-component symlinks', async () => {
    fs.writeFileSync(path.join(workDir, 'note.txt'), 'newer');
    await expect(
      writeSessionFile(workDir, 'note.txt', Buffer.from('after'), sha256('older'), 100, () => true),
    ).resolves.toEqual({ status: 'conflict' });
    expect(fs.readFileSync(path.join(workDir, 'note.txt'), 'utf8')).toBe('newer');

    fs.symlinkSync(path.join(workDir, 'note.txt'), path.join(workDir, 'link.txt'));
    await expect(
      writeSessionFile(workDir, 'link.txt', Buffer.from('after'), sha256('newer'), 100, () => true),
    ).resolves.toEqual({ status: 'forbidden' });
  });

  it('checks authorization immediately before rename and leaves no temporary file when locked', async () => {
    fs.writeFileSync(path.join(workDir, 'note.txt'), 'before');

    await expect(
      writeSessionFile(workDir, 'note.txt', Buffer.from('after'), sha256('before'), 100, () => false),
    ).resolves.toEqual({ status: 'locked' });
    expect(fs.readFileSync(path.join(workDir, 'note.txt'), 'utf8')).toBe('before');
    expect(fs.readdirSync(workDir)).toEqual(['note.txt']);
  });
});
