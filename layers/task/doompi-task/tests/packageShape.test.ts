import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  type: string;
  exports?: Record<string, unknown>;
  files?: string[];
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
}

/** Release bumps rewrite the manifest version, so assert its shape rather than a fixed value. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const configurationFiles = [
  'package.json',
  'project.json',
  'tsconfig.json',
  'tsdown.config.ts',
  'vitest.config.ts',
  'vibe-lint.config.yaml',
  '.oxlintrc.json',
];

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
}

function targetPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value).flatMap(targetPaths);
}

function conditionPaths(value: unknown, condition: string): string[] {
  if (typeof value === 'string' || value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const direct = record[condition];
  return direct === undefined
    ? Object.values(record).flatMap((nested) => conditionPaths(nested, condition))
    : targetPaths(direct);
}

async function expectFile(relativePath: string): Promise<void> {
  await expect(access(path.resolve(packageDirectory, relativePath))).resolves.toBeUndefined();
}

describe('doom-task package boundary', () => {
  it('retains the publishable package identity and exact Pi peer versions', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-task');
    expect(manifest.version).toMatch(SEMVER_PATTERN);
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.peerDependencies).toEqual(
      expect.objectContaining({
        '@earendil-works/pi-coding-agent': '0.84.4',
        '@earendil-works/pi-tui': '0.84.4',
      }),
    );
    expect(manifest.devDependencies).toEqual(
      expect.objectContaining({
        '@earendil-works/pi-coding-agent': '0.84.4',
        '@earendil-works/pi-tui': '0.84.4',
      }),
    );
  });

  it('removes rig package dependencies and config imports', async () => {
    for (const file of configurationFiles) {
      const contents = await readFile(path.join(packageDirectory, file), 'utf8').catch(() => '');
      expect(contents, file).not.toMatch(/@agimon-ai\/rig-/u);
    }
  });

  it('uses a package-local source root and declares the standard Pi adapter', async () => {
    const manifest = await readManifest();
    const project = JSON.parse(await readFile(path.join(packageDirectory, 'project.json'), 'utf8')) as {
      sourceRoot?: string;
      sourceTemplate?: string;
    };

    expect(project.sourceRoot).toBe('layers/task/doompi-task/src');
    expect(project.sourceTemplate).toBe('doom-extension');
    expect(manifest.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
  });

  it('exports only the standard Pi adapter without a wildcard', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};
    const publicEntries = Object.entries(exportsMap).filter(([subpath]) => subpath !== './package.json');

    expect(Object.keys(exportsMap)).not.toContain('./*');
    expect(Object.keys(exportsMap)).toContain('./extensions/pi');
    expect(Object.keys(exportsMap)).not.toContain('./extensions/doom');
    expect(publicEntries.length).toBeGreaterThan(0);
    for (const [subpath, target] of publicEntries) {
      expect(conditionPaths(target, 'import'), subpath).toHaveLength(1);
      expect(conditionPaths(target, 'require'), subpath).toHaveLength(1);
      expect(conditionPaths(target, 'types'), subpath).toHaveLength(1);
      for (const output of targetPaths(target)) await expectFile(output);
    }
  });

  it('publishes only allowlisted built resources with public package access', async () => {
    const manifest = await readManifest();
    const files = manifest.files ?? [];
    const publishConfig = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as {
      publishConfig?: { access?: string };
    };

    expect(publishConfig.publishConfig?.access).toBe('public');
    expect(files.some((entry) => entry === 'dist' || entry === 'dist/**' || entry.startsWith('dist/'))).toBe(true);
    expect(files).not.toContain('src');
    expect(files).not.toContain('tests');
    expect(files).toContain('package.json');
    for (const resource of files) {
      if (resource.includes('*')) continue;
      await expectFile(resource);
    }
  });
});
