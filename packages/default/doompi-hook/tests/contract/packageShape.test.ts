import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  private?: boolean;
  type?: string;
  files?: string[];
  keywords?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: { access?: string };
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
}

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
}

function conditions(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value);
}

describe('doompi-hook package contract', () => {
  it('is a public ESM package with an explicit publish allowlist', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-hook');
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.engines?.node).toBe('>=22.19.0');
    expect(manifest.files).toEqual(['dist', 'llms.txt', 'README.md', 'src/prompts', 'LICENSE', 'package.json']);
  });

  it('carries the distribution keywords alongside its own, sorted', async () => {
    const manifest = await readManifest();
    const keywords = manifest.keywords ?? [];

    expect(keywords).toEqual(expect.arrayContaining(['ai', 'coding-agent', 'developer-tools', 'doompi', 'pi-package']));
    expect(keywords).toEqual([...keywords].sort());
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it('publishes one closed Pi entry through pi.extensions', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};

    expect(Object.keys(exportsMap)).toEqual(['.', './extensions/pi', './package.json']);
    expect(Object.keys(exportsMap)).not.toContain('./*');
    expect(Object.keys(exportsMap)).not.toContain('./extensions/doom');
    for (const subpath of ['.', './extensions/pi']) {
      expect(conditions(exportsMap[subpath])).toEqual(['types', 'import', 'require']);
    }
    expect(manifest.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
  });

  it('routes the Pi entry through a default-exported factory on the shared Cordis host', async () => {
    const entry = await readFile(path.join(packageDirectory, 'src/exports/extensions/pi.ts'), 'utf8');
    const factory = await readFile(path.join(packageDirectory, 'src/adapters/pi/extension.ts'), 'utf8');

    expect(entry).toContain("from '../../adapters/pi/extension.ts'");
    expect(entry).toContain('as default');
    expect(entry).not.toContain('doom.ts');
    expect(factory).toContain('connectDoomCordisHost');
    expect(factory).toContain('connection.root.plugin(');
    expect(factory).not.toContain('new Context()');
    expect(
      factory.match(/await fiber\.dispose\(\);\s*\}\s*finally\s*\{\s*await connection\.dispose\(\);/gu),
    ).toHaveLength(2);
    expect(factory).toContain('registerHookHandlers');
    expect(factory).toContain('inject([DOOM_HELP_SERVICE]');
    expect(factory).toContain("name: 'doompi-author-hook'");
  });

  it('never depends on the host package, which would make the build graph cyclic', async () => {
    const manifest = await readManifest();
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];

    expect(declared).not.toContain('@agimon-ai/doompi');
  });

  it('pins the Pi peer and development versions and keeps the peer optional', async () => {
    const manifest = await readManifest();

    expect(manifest.peerDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.85.0');
    expect(manifest.devDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.85.0');
    expect(manifest.peerDependenciesMeta?.['@earendil-works/pi-coding-agent']).toEqual({ optional: true });
  });

  it('ships an H1-led Help index whose linked resources are allowlisted', async () => {
    const manifest = await readManifest();
    const index = await readFile(path.join(packageDirectory, 'llms.txt'), 'utf8');

    expect(index).toMatch(/^# Doom Pi Hook$/m);
    expect(index).toContain('(./README.md)');
    expect(index).toContain('(./src/prompts/doompi-author-hook/SKILL.md)');
    expect(manifest.files).toEqual(expect.arrayContaining(['llms.txt', 'README.md', 'src/prompts']));
  });

  it('documents default distribution activation and layer-owned hook-group selection', async () => {
    const readme = await readFile(path.join(packageDirectory, 'README.md'), 'utf8');

    expect(readme).toContain('distribution activates this package by default');
    expect(readme).toContain('Layers only declare the `hookGroups`');
  });

  it('declares no protocol channel literals, which belong to the contracts package', async () => {
    const sources = await Promise.all(
      [
        'src/adapters/pi/extension.ts',
        'src/adapters/pi/hookHandlers.ts',
        'src/adapters/hookDocuments.ts',
        'src/adapters/hookRunner.ts',
        'src/exports/index.ts',
      ].map((relativePath) => readFile(path.join(packageDirectory, relativePath), 'utf8')),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/['"`]doom:/);
      expect(source).not.toMatch(/\.events\.(?:emit|on)\s*\(/);
    }
  });
});
