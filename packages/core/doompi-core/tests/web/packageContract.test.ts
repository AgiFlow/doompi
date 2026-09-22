import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly type: string;
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly files?: readonly string[];
  readonly pi?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { optional?: boolean }>>;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
}

describe('core web capability package boundary', () => {
  it('publishes web capabilities and keeps browser rendering peers optional', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-core');
    expect(manifest.version).toMatch(SEMVER_PATTERN);
    expect(manifest.type).toBe('module');
    expect(manifest.pi).toBeUndefined();
    expect(manifest.dependencies).toMatchObject({
      '@tanstack/store': '0.11.1',
    });
    expect(manifest.devDependencies).not.toHaveProperty('@tanstack/store');
    expect(manifest.peerDependencies).not.toHaveProperty('@tanstack/store');
    expect(manifest.peerDependencies).toMatchObject({
      react: '19.3.0',
      'react-dom': '19.3.0',
    });
    expect(manifest.peerDependenciesMeta).not.toHaveProperty('@tanstack/store');
    expect(manifest.peerDependenciesMeta).toMatchObject({
      react: { optional: true },
      'react-dom': { optional: true },
    });
    expect(Object.keys(manifest.exports ?? {})).toEqual(
      expect.arrayContaining(['./web', './webTesting', './package.json']),
    );
    expect(manifest.exports).not.toHaveProperty('./*');
    expect(manifest.files).toContain('dist');
  });
});
