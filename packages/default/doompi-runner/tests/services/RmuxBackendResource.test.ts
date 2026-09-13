import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveBundledRmuxBinary, rmuxPackageForTarget } from '../../src/services/rmuxBackend';

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
