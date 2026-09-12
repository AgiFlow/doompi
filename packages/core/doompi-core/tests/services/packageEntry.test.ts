import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packageEntry } from '../../src/services/moduleResolution';

describe('host package entry resolution', () => {
  it.each([
    { main: 'dist/index.js' },
    { module: 'dist/index.js' },
    { exports: { '.': { import: './dist/index.js' } } },
    { exports: { import: './dist/index.js' } },
  ])('resolves a declared root entry and canonicalizes its dependency location: %j', (fields) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-host-entry-'));
    try {
      const host = path.join(root, 'host');
      const dependency = path.join(root, 'store', 'package');
      fs.mkdirSync(path.join(dependency, 'dist'), { recursive: true });
      fs.mkdirSync(path.join(host, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'host-runtime', ...fields }));
      fs.writeFileSync(path.join(dependency, 'dist/index.js'), 'export const value = 1;');
      fs.symlinkSync(dependency, path.join(host, 'node_modules/host-runtime'), 'dir');
      expect(packageEntry('host-runtime', pathToFileURL(path.join(host, 'entry.mjs')).href)).toBe(
        fs.realpathSync(path.join(dependency, 'dist/index.js')),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
