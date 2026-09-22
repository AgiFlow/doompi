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
  readonly dependencies?: Record<string, string>;
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
const doomDependencies = ['@agimon-ai/doompi-core', '@agimon-ai/doompi-hashline', '@agimon-ai/doompi-ui'] as const;

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

describe('doompi-grep package contract', () => {
  it('retains a publishable identity with exact Pi peers and workspace Doom dependencies', async () => {
    const manifest = await readManifest();
    expect(manifest.name).toBe('@agimon-ai/doompi-grep');
    expect(manifest.version).toMatch(SEMVER_PATTERN);
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig?.access).toBe('public');
    for (const dependency of piPeers) {
      expect(manifest.peerDependencies?.[dependency]).toBe('0.87.0');
      expect(manifest.devDependencies?.[dependency]).toBe('0.87.0');
    }
    for (const dependency of doomDependencies) expect(manifest.dependencies?.[dependency]).toBe('workspace:*');
  });

  it('uses the canonical default package root and source template', async () => {
    const project = JSON.parse(
      await readFile(path.join(packageDirectory, 'project.json'), 'utf8'),
    ) as ProjectConfiguration;
    expect(project.sourceRoot).toBe('packages/default/doompi-grep/src');
    expect(project.sourceTemplate).toBe('doom-extension');
  });

  it('keeps exports closed with ESM, CJS, and declaration build outputs', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};
    // The browser bundle is ESM only and carries no declarations: nothing
    // imports it as a typed module, and the cockpit consumes it as a bundle.
    expect(exportsMap['./extensions/web']).toEqual({ import: './dist/extensions/web.mjs' });
    const publicEntries = Object.entries(exportsMap).filter(
      ([subpath]) => subpath !== './package.json' && subpath !== './extensions/web',
    );
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
    // Only built artifacts. The browser half used to ship as source for the
    // cockpit to compile; it is now a browser bundle in dist like the rest.
    expect(manifest.files).toEqual(['dist']);
    expect(manifest.files).not.toContain('src');
    expect(manifest.files).not.toContain('tests');
    await expect(access(path.join(packageDirectory, 'dist'))).resolves.toBeUndefined();
  });
});
