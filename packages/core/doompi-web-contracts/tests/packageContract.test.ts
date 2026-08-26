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
  readonly peerDependenciesMeta?: Readonly<Record<string, { optional?: boolean }>>;
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
    // Contracts carry no runtime dependency of their own, so any plugin author
    // can adopt them. defineSessionStore constructs a TanStack store, but the
    // host owns the one instance the cockpit bundle dedupes on, so it is a peer.
    // react and react-dom are peers only because ./testing renders a component
    // to markup; both are optional, so the contract itself still installs bare.
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toEqual({
      '@tanstack/store': '0.11.1',
      react: '19.2.8',
      'react-dom': '19.2.8',
    });
    expect(manifest.peerDependenciesMeta).toEqual({
      react: { optional: true },
      'react-dom': { optional: true },
    });
    expect(Object.keys(manifest.exports ?? {})).toEqual(['.', './package.json', './testing']);
    expect(manifest.files).toEqual(['dist']);
  });
});
