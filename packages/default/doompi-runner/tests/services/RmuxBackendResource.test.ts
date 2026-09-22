import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureExecutablePayload,
  resolveBundledRmuxBinary,
  rmuxPackageForTarget,
} from '../../src/services/rmuxBackend';

const PUBLISHED_MODE = 0o644;
const EXECUTABLE_BITS = 0o111;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('packaged RMUX resource resolution', () => {
  it('resolves the executable from a generated module graph', () => {
    const packageName = rmuxPackageForTarget(process.platform, process.arch);
    if (!packageName) return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-rmux-resource-'));
    directories.push(directory);
    const packageDirectory = path.join(directory, 'node_modules', ...packageName.split('/'));
    const binary = path.join(packageDirectory, 'vendor', 'bin', 'rmux');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({ name: packageName, exports: { './package.json': './package.json' } }),
    );
    fs.writeFileSync(binary, 'rmux');
    const moduleUrl = pathToFileURL(path.join(directory, 'module.mjs'));

    expect(resolveBundledRmuxBinary(moduleUrl.href)).toBe(fs.realpathSync(binary));
  });

  it('makes every published payload file runnable, not just the launcher', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-rmux-payload-'));
    directories.push(directory);
    const vendor = path.join(directory, 'vendor');
    // The three files the prebuilt packages ship, at the mode npm publishes them with.
    const files = [
      path.join(vendor, 'bin', 'rmux'),
      path.join(vendor, 'bin', 'rmux-daemon'),
      path.join(vendor, 'libexec', 'rmux', 'rmux'),
    ];
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'rmux', { mode: PUBLISHED_MODE });
    }

    ensureExecutablePayload(files[0] as string);

    for (const file of files) expect(fs.statSync(file).mode & EXECUTABLE_BITS).not.toBe(0);
  });

  it('leaves a stand-alone override alone apart from itself', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-rmux-override-'));
    directories.push(directory);
    const binary = path.join(directory, 'rmux');
    const neighbour = path.join(directory, 'notes.txt');
    fs.writeFileSync(binary, 'rmux', { mode: PUBLISHED_MODE });
    fs.writeFileSync(neighbour, 'notes', { mode: PUBLISHED_MODE });

    ensureExecutablePayload(binary);

    expect(fs.statSync(binary).mode & EXECUTABLE_BITS).not.toBe(0);
    expect(fs.statSync(neighbour).mode & EXECUTABLE_BITS).toBe(0);
  });

  it('keeps the configured executable override authoritative', () => {
    const previous = process.env.DOOMPI_RMUX_BINARY;
    process.env.DOOMPI_RMUX_BINARY = '/configured/rmux';
    try {
      expect(resolveBundledRmuxBinary()).toBe('/configured/rmux');
    } finally {
      if (previous === undefined) delete process.env.DOOMPI_RMUX_BINARY;
      else process.env.DOOMPI_RMUX_BINARY = previous;
    }
  });
});
