import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly type: string;
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly files?: readonly string[];
  readonly pi?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
}

describe('doompi-web-contracts package boundary', () => {
  it('is a publishable non-Pi contracts package with closed exports and zero runtime deps', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-web-contracts');
    expect(manifest.version).toMatch(SEMVER_PATTERN);
    expect(manifest.type).toBe('module');
    expect(manifest.pi).toBeUndefined();
    // Contracts stay dependency-free so any plugin author can adopt them; react
    // appears only as a devDependency for its component types.
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(Object.keys(manifest.exports ?? {})).toEqual(['.', './package.json']);
    expect(manifest.files).toEqual(['dist']);
  });
});
