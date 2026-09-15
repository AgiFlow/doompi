import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sessionFilesApi } from '../../../../../src/server/sessionFilesApi';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe('session file completion', () => {
  it('lists only files inside the owning cwd, excludes dependencies, and does not follow directory links', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-files-'));
    roots.push(root);
    const cwd = path.join(root, 'repo');
    fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'other'));
    fs.writeFileSync(path.join(cwd, 'readme.md'), 'local');
    fs.writeFileSync(path.join(root, 'other', 'secret.md'), 'outside');
    fs.writeFileSync(path.join(cwd, 'node_modules', 'dependency.md'), 'dependency');
    fs.symlinkSync(path.join(root, 'other'), path.join(cwd, 'linked'), 'dir');
    const handler = sessionFilesApi.start({ scope: 'session', sessionId: 'one', cwd, onNotice() {} });
    try {
      expect(await (await handler.fetch(new Request('http://files/?q=README'))).json()).toEqual({
        files: ['readme.md'],
      });
      expect(await (await handler.fetch(new Request('http://files/?q=.md'))).json()).toEqual({ files: ['readme.md'] });
      expect((await handler.fetch(new Request(`http://files/?q=${'a'.repeat(257)}`))).status).toBe(400);
    } finally {
      handler.close();
    }
    expect((await handler.fetch(new Request('http://files/'))).status).toBe(503);
  });

  it('prunes directories and files the project ignores through .gitignore and .doomignore', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-files-'));
    roots.push(cwd);
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.nx-cache/\n*.log\n');
    fs.writeFileSync(path.join(cwd, '.doomignore'), 'notes/\n');
    fs.mkdirSync(path.join(cwd, '.nx-cache', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'notes'));
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, '.nx-cache', 'deep', 'cached.ts'), 'cached');
    fs.writeFileSync(path.join(cwd, 'notes', 'scratch.ts'), 'scratch');
    fs.writeFileSync(path.join(cwd, 'debug.log'), 'noise');
    fs.writeFileSync(path.join(cwd, 'src', 'kept.ts'), 'kept');
    const handler = sessionFilesApi.start({ scope: 'session', sessionId: 'one', cwd, onNotice() {} });
    try {
      expect(await (await handler.fetch(new Request('http://files/?q='))).json()).toEqual({
        files: ['.doomignore', '.gitignore', 'src/', 'src/kept.ts'],
      });
      // A folder is completable, so the @ popup can name a whole directory.
      expect(await (await handler.fetch(new Request('http://files/?q=src'))).json()).toEqual({
        files: ['src/', 'src/kept.ts'],
      });
    } finally {
      handler.close();
    }
  });

  it('lists everything when the project declares no ignore rules', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-files-'));
    roots.push(cwd);
    fs.writeFileSync(path.join(cwd, 'debug.log'), 'noise');
    const handler = sessionFilesApi.start({ scope: 'session', sessionId: 'one', cwd, onNotice() {} });
    try {
      expect(await (await handler.fetch(new Request('http://files/?q='))).json()).toEqual({ files: ['debug.log'] });
    } finally {
      handler.close();
    }
  });
});
