import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly type: string;
  readonly exports?: Record<string, unknown>;
  readonly files?: string[];
  readonly publishConfig?: { readonly access?: string };
  readonly peerDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

interface ProjectConfiguration {
  readonly sourceRoot?: string;
  readonly sourceTemplate?: string;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = path.join(packageDirectory, 'package.json');
const piPeers = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui'] as const;

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
}

function targetPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value).flatMap(targetPaths);
}

function conditionPaths(value: unknown, condition: string): string[] {
  if (typeof value === 'string' || value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return record[condition] === undefined
    ? Object.values(record).flatMap((nested) => conditionPaths(nested, condition))
    : targetPaths(record[condition]);
}

describe('doompi-edit package contract', () => {
  it('retains a publishable identity and exact Pi peer versions', async () => {
    const manifest = await readManifest();
    expect(manifest.name).toBe('@agimon-ai/doompi-edit');
    expect(manifest.version).toMatch(SEMVER_PATTERN);
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig?.access).toBe('public');
    for (const dependency of piPeers) {
      expect(manifest.peerDependencies?.[dependency]).toBe('0.84.4');
      expect(manifest.devDependencies?.[dependency]).toBe('0.84.4');
    }
  });

  it('uses the canonical default package root and source template', async () => {
    const project = JSON.parse(
      await readFile(path.join(packageDirectory, 'project.json'), 'utf8'),
    ) as ProjectConfiguration;
    expect(project.sourceRoot).toBe('packages/default/doompi-edit/src');
    expect(project.sourceTemplate).toBe('doom-extension');
  });

  it('keeps exports closed with ESM, CJS, and declaration build outputs', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};
    const publicEntries = Object.entries(exportsMap).filter(([subpath]) => subpath !== './package.json');
    expect(publicEntries.length).toBeGreaterThan(0);
    expect(Object.keys(exportsMap)).not.toContain('./*');

    for (const [subpath, target] of publicEntries) {
      expect(conditionPaths(target, 'import'), subpath).toHaveLength(1);
      expect(conditionPaths(target, 'require'), subpath).toHaveLength(1);
      expect(conditionPaths(target, 'types'), subpath).toHaveLength(1);
      for (const output of targetPaths(target)) {
        await expect(access(path.resolve(packageDirectory, output))).resolves.toBeUndefined();
      }
    }
  });

  it('publishes only built files plus its allowlisted package manifest', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};
    expect(exportsMap['./package.json']).toBeDefined();
    expect(manifest.files).toEqual(['dist', 'web']);
    expect(manifest.files).not.toContain('src');
    expect(manifest.files).not.toContain('tests');
    await expect(access(path.join(packageDirectory, 'dist'))).resolves.toBeUndefined();
  });
});
