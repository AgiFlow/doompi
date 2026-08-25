import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSessionFiles } from '../../src/adapters/sessionFiles.ts';

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
