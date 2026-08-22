import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOOM_PACKAGE_NAME,
  enclosingPackageName,
  isDoomPackagePath,
  manifestName,
} from '../../src/adapters/doomPackage.ts';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-package-')));
  temporaryRoots.push(root);
  return root;
}

function writePackage(directory: string, name?: string): string {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), name === undefined ? '{}' : JSON.stringify({ name }));
  return directory;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('manifestName', () => {
  it('reads the name of a package root', () => {
    const root = writePackage(temporaryRoot(), DOOM_PACKAGE_NAME);

    expect(manifestName(root)).toBe(DOOM_PACKAGE_NAME);
  });

  it('treats a missing, unreadable, or nameless manifest as no package', () => {
    const root = temporaryRoot();

    expect(manifestName(path.join(root, 'absent'))).toBeUndefined();
    expect(manifestName(writePackage(path.join(root, 'nameless')))).toBeUndefined();

    fs.writeFileSync(path.join(root, 'package.json'), 'not json');
    expect(manifestName(root)).toBeUndefined();
  });
});

describe('enclosingPackageName', () => {
  it('walks up from a nested file to the package that owns it', () => {
    const root = writePackage(temporaryRoot(), DOOM_PACKAGE_NAME);
    const nested = path.join(root, 'dist', 'extensions');
    fs.mkdirSync(nested, { recursive: true });
    const entry = path.join(nested, 'pi.mjs');
    fs.writeFileSync(entry, 'export default () => undefined;\n');

    expect(enclosingPackageName(entry)).toBe(DOOM_PACKAGE_NAME);
    expect(isDoomPackagePath(entry)).toBe(true);
  });

  it('stops at the nearest package rather than the first matching one', () => {
    const root = writePackage(temporaryRoot(), DOOM_PACKAGE_NAME);
    const vendored = writePackage(path.join(root, 'vendor', 'other'), '@example/other');

    expect(enclosingPackageName(vendored)).toBe('@example/other');
    expect(isDoomPackagePath(vendored)).toBe(false);
  });

  it('reports nothing for an absent path and for one under no package at all', () => {
    const root = temporaryRoot();
    const orphan = path.join(root, 'loose', 'file.mjs');
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, '\n');

    expect(enclosingPackageName(path.join(root, 'absent'))).toBeUndefined();
    expect(isDoomPackagePath(path.join(root, 'absent'))).toBe(false);
    // Walks all the way to the filesystem root without finding a manifest.
    expect(enclosingPackageName(orphan)).toBeUndefined();
  });
});
