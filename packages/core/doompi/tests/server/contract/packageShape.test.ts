import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface PackageManifest {
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const packageDirectory = fileURLToPath(new URL('../../..', import.meta.url));

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
}

describe('doompi core server surface', () => {
  it('publishes the server barrel and executable', async () => {
    const manifest = await readManifest();
    expect(manifest.bin?.['doompi-server']).toBe('./dist/bin/serve.mjs');
    const coreManifest = JSON.parse(
      await readFile(new URL('../../../../doompi-core/package.json', import.meta.url), 'utf8'),
    ) as PackageManifest;
    expect(coreManifest.exports?.['./server']).toEqual({
      types: './dist/server.d.mts',
      import: './dist/server.mjs',
      require: './dist/server.cjs',
    });
  });

  it('declares the server runtime dependencies', async () => {
    const manifest = await readManifest();
    expect(manifest.dependencies).toMatchObject({
      '@earendil-works/chord': '0.85.1',
      '@earendil-works/pi-protocol': '0.85.1',
      '@hono/node-server': '2.1.1',
    });
    expect(manifest.devDependencies?.['@earendil-works/pi-client']).toBe('0.85.1');
  });

  it('keeps serve as a dedicated tsdown entry', async () => {
    const config = await readFile(path.join(packageDirectory, 'tsdown.config.ts'), 'utf8');
    expect(config).toContain("'bin/serve': 'src/bin/serve.ts'");
  });

  it('does not fall back to the installation directory for server registration', async () => {
    const source = await readFile(path.join(packageDirectory, 'src/bin/serve.ts'), 'utf8');
    expect(source).not.toContain('registeredSync(installationDir)');
  });
});
