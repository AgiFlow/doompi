import { access, readFile } from 'node:fs/promises';
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
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
}

function targetPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value).flatMap(targetPaths);
}

describe('doompi-hashline package boundary', () => {
  it('is a publishable non-Pi foundation package with closed exports', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-hashline');
    expect(manifest.version).toMatch(SEMVER_PATTERN);
    expect(manifest.type).toBe('module');
    expect(manifest.pi).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(Object.keys(manifest.exports ?? {})).toEqual(['.', './files', './package.json']);
    expect(manifest.files).toEqual(['dist']);
  });

  it('builds every allowlisted export target', async () => {
    const manifest = await readManifest();
    for (const target of Object.values(manifest.exports ?? {}).flatMap(targetPaths)) {
      await expect(access(path.resolve(packageDirectory, target))).resolves.toBeUndefined();
    }
  });
});
