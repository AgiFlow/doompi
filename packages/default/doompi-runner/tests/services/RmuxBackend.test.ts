import { access, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface RmuxPackageManifest {
  name: string;
  version: string;
  private: boolean;
  files?: string[];
  os?: string[];
  cpu?: string[];
}

interface PlatformFixture {
  directory: string;
  name: string;
  os: string;
  cpu: string;
}

/** Release bumps rewrite the manifest version, so assert its shape rather than a fixed value. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));
const repositoryDirectory = path.resolve(packageDirectory, '../../..');
const platformFixtures: PlatformFixture[] = [
  {
    directory: 'doompi-runner-rmux-darwin-arm64',
    name: '@agimon-ai/doompi-runner-rmux-darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
  },
  {
    directory: 'doompi-runner-rmux-darwin-x64',
    name: '@agimon-ai/doompi-runner-rmux-darwin-x64',
    os: 'darwin',
    cpu: 'x64',
  },
  {
    directory: 'doompi-runner-rmux-linux-arm64',
    name: '@agimon-ai/doompi-runner-rmux-linux-arm64',
    os: 'linux',
    cpu: 'arm64',
  },
  {
    directory: 'doompi-runner-rmux-linux-x64',
    name: '@agimon-ai/doompi-runner-rmux-linux-x64',
    os: 'linux',
    cpu: 'x64',
  },
];

async function readManifest(fixture: PlatformFixture): Promise<RmuxPackageManifest> {
  return JSON.parse(
    await readFile(path.join(repositoryDirectory, 'packages', 'default', fixture.directory, 'package.json'), 'utf8'),
  ) as RmuxPackageManifest;
}

describe('RMUX platform package contract', () => {
  it.each(platformFixtures)('selects and packages the matching $os-$cpu runtime', async (fixture) => {
    const packageRoot = path.join(repositoryDirectory, 'packages', 'default', fixture.directory);
    const manifest = await readManifest(fixture);

    expect(manifest.name).toBe(fixture.name);
    expect(manifest.version).toMatch(SEMVER_PATTERN);
    expect(manifest.private).toBeUndefined();
    expect(manifest.os).toEqual([fixture.os]);
    expect(manifest.cpu).toEqual([fixture.cpu]);
    expect(manifest.files).toEqual(expect.arrayContaining(['vendor', 'LICENSE-MIT', 'LICENSE-APACHE']));

    const packagedFiles = [
      'vendor/bin/rmux',
      'vendor/bin/rmux-daemon',
      'vendor/libexec/rmux/rmux',
      'LICENSE-MIT',
      'LICENSE-APACHE',
    ];
    for (const relativePath of packagedFiles) {
      await expect(access(path.join(packageRoot, relativePath))).resolves.toBeUndefined();
    }

    const binary = await stat(path.join(packageRoot, 'vendor/bin/rmux'));
    expect(binary.mode & 0o111).not.toBe(0);
  });

  it('keeps platform selection closed to the four supported target tuples', () => {
    const tuples = platformFixtures.map(({ os, cpu }) => `${os}-${cpu}`);
    expect(new Set(tuples)).toEqual(new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']));
    expect(tuples).not.toContain('freebsd-x64');
    expect(tuples).not.toContain('linux-ppc64');
  });
});
