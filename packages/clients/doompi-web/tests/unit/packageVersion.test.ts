import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packagedVersion } from '../../src/adapters/packageVersion';

const previousRoot = process.env.DOOMPI_WEB_PACKAGE_ROOT;
const roots: string[] = [];
afterEach(() => {
  if (previousRoot === undefined) delete process.env.DOOMPI_WEB_PACKAGE_ROOT;
  else process.env.DOOMPI_WEB_PACKAGE_ROOT = previousRoot;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(contents?: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-web-version-'));
  roots.push(directory);
  if (contents !== undefined) fs.writeFileSync(path.join(directory, 'package.json'), contents);
  process.env.DOOMPI_WEB_PACKAGE_ROOT = directory;
  return directory;
}

describe('packaged web version', () => {
  it('reads the selected package manifest', () => {
    root('{"version":"2.3.4"}');
    expect(packagedVersion()).toBe('2.3.4');
  });

  it('reports an unknown version for missing, malformed, and non-string values', () => {
    root();
    expect(packagedVersion()).toBe('unknown');
    root('invalid json');
    expect(packagedVersion()).toBe('unknown');
    root('{"version":42}');
    expect(packagedVersion()).toBe('unknown');
  });

  it('uses the installed package when the override is empty', () => {
    process.env.DOOMPI_WEB_PACKAGE_ROOT = '';
    expect(packagedVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
