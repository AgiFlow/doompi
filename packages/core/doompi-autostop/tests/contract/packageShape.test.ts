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
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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

describe('doompi-autostop package contract', () => {
  it('is a public ESM package with an explicit publish allowlist', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-autostop');
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'llms.txt', 'README.md', 'package.json']));
    expect(manifest.keywords).toEqual([
      'ai',
      'auto-stop',
      'coding-agent',
      'developer-tools',
      'doompi',
      'idle-timeout',
      'pi-coding-agent',
      'pi-extension',
      'pi-package',
      'session-shutdown',
    ]);
  });

  it('publishes one Pi entry through a closed exports map', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};

    expect(Object.keys(exportsMap)).toEqual(['.', './extensions/pi', './package.json']);
    expect(Object.keys(exportsMap)).not.toContain('./*');
    for (const subpath of ['.', './extensions/pi']) {
      expect(conditions(exportsMap[subpath])).toEqual(['types', 'import', 'require']);
    }
    expect(manifest.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
  });

  it('routes the Pi entry through a default-exported factory', async () => {
    const entry = await readFile(path.join(packageDirectory, 'src/exports/extensions/pi.ts'), 'utf8');
    const factory = await readFile(path.join(packageDirectory, 'src/adapters/pi/extension.ts'), 'utf8');

    expect(entry).toContain("from '../../adapters/pi/extension.ts'");
    expect(entry).toContain('as default');
    expect(factory).toContain('registerIdleShutdown');
    expect(factory).toContain('connectDoomCordisHost');
    expect(factory).toContain('connection.root.plugin');
    expect(factory).not.toContain('new Context()');
  });

  it('never depends on the host package, which would make the build graph cyclic', async () => {
    const manifest = await readManifest();
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];

    expect(declared).not.toContain('@agimon-ai/doompi');
    // The idle policy needs only the shared host contract and Cordis lifecycle.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@agimon-ai/doompi-extension-contracts',
      '@deepseek-ai/cordis',
    ]);
  });

  it('ships an H1-led Help index whose linked resources are allowlisted', async () => {
    const manifest = await readManifest();
    const index = await readFile(path.join(packageDirectory, 'llms.txt'), 'utf8');

    expect(index).toMatch(/^# Doom Pi Autostop$/m);
    expect(index).toContain('(./README.md)');
    expect(manifest.files).toEqual(expect.arrayContaining(['llms.txt', 'README.md']));
  });

  it('pins matching Pi peer and development versions', async () => {
    const manifest = await readManifest();

    expect(manifest.peerDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.2');
    expect(manifest.devDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.2');
  });
});
