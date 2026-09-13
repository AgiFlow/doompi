import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mirrorComposition } from '../../../../src/services/compositionMirror';

let source: string;
let target: string;

function write(root: string, relative: string, contents = 'x'): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

beforeEach(() => {
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-mirror-src-'));
  target = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-mirror-dst-'));
});

afterEach(() => {
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

describe('mirrorComposition', () => {
  // A repository with nothing installed has nothing to lend, and a Rust or Go
  // checkout must not pay for a scan it can never use.
  it('does nothing when the parent has no modules of its own', () => {
    write(source, 'packages/one/dist/index.mjs');

    expect(mirrorComposition(source, target)).toEqual({ kind: 'skipped', reason: 'no-modules' });
    expect(fs.existsSync(path.join(target, 'packages/one/dist'))).toBe(false);
  });

  it('copies build output and links module trees', () => {
    write(source, 'node_modules/left-pad/index.js');
    write(source, 'packages/one/node_modules/.bin/tool');
    write(source, 'packages/one/dist/extensions/pi.mjs', 'built');
    write(source, 'layers/group/two/dist/index.mjs', 'built');

    expect(mirrorComposition(source, target)).toEqual({ kind: 'mirrored', copied: 2, linked: 2 });

    // Output is copied, so a build inside the worktree cannot reach back into
    // the parent's directory.
    expect(fs.lstatSync(path.join(target, 'packages/one/dist')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(target, 'packages/one/dist/extensions/pi.mjs'), 'utf8')).toBe('built');
    expect(fs.readFileSync(path.join(target, 'layers/group/two/dist/index.mjs'), 'utf8')).toBe('built');
    // Modules are linked, because copying gigabytes is not a spawn.
    expect(fs.lstatSync(path.join(target, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(target, 'packages/one/node_modules')).isSymbolicLink()).toBe(true);
  });

  it('never walks into a module tree looking for build output', () => {
    write(source, 'node_modules/a-package/dist/index.js');

    const outcome = mirrorComposition(source, target);

    expect(outcome).toEqual({ kind: 'mirrored', copied: 0, linked: 1 });
    expect(fs.existsSync(path.join(target, 'node_modules/a-package'))).toBe(true);
  });

  // A checkout that commits its build output already has the real thing.
  it('leaves anything the worktree already has', () => {
    write(source, 'node_modules/left-pad/index.js');
    write(source, 'packages/one/dist/index.mjs', 'parent');
    write(target, 'packages/one/dist/index.mjs', 'child');

    expect(mirrorComposition(source, target)).toEqual({ kind: 'mirrored', copied: 0, linked: 1 });
    expect(fs.readFileSync(path.join(target, 'packages/one/dist/index.mjs'), 'utf8')).toBe('child');
  });
});
