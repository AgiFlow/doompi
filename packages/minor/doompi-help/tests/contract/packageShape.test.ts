// @scaffold-generated
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

describe('doompi-help package contract', () => {
  it('is a public ESM package with an explicit publish allowlist', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-help');
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'llms.txt', 'README.md', 'package.json']));
    expect(manifest.keywords).toEqual([
      'agent-documentation',
      'ai',
      'coding-agent',
      'developer-tools',
      'doompi',
      'help-system',
      'pi-coding-agent',
      'pi-extension',
      'pi-package',
      'skills',
    ]);
  });

  it('keeps closed ESM, CJS, and declaration exports plus Pi discovery metadata', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};

    expect(Object.keys(exportsMap)).toEqual(['.', './extensions/pi', './package.json']);
    expect(Object.keys(exportsMap)).not.toContain('./*');
    expect(Object.keys(exportsMap)).not.toContain('./extensions/doom');
    expect(conditions(exportsMap['.'])).toEqual(['types', 'import', 'require']);
    expect(conditions(exportsMap['./extensions/pi'])).toEqual(['types', 'import', 'require']);
    expect(manifest.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
  });

  it('routes Pi discovery through the sole command and typed-mode factory', async () => {
    const entrySource = await readFile(path.join(packageDirectory, 'src/exports/extensions/pi.ts'), 'utf8');
    const factorySource = await readFile(path.join(packageDirectory, 'src/adapters/pi/extension.ts'), 'utf8');

    expect(entrySource).toContain("from '../../adapters/pi/extension'");
    expect(entrySource).not.toContain('doom.ts');
    expect(factorySource).toContain('registerHelpCommand');
    expect(factorySource).toContain('registerHelpModeIntegration');
    expect(factorySource).toContain('connectDoomCordisHost');
    expect(factorySource).toContain('connection.root.plugin');
    expect(factorySource).not.toContain('new Context()');
  });

  it('ships an H1-led Help index whose linked resources are allowlisted', async () => {
    const manifest = await readManifest();
    const index = await readFile(path.join(packageDirectory, 'llms.txt'), 'utf8');

    expect(index).toMatch(/^# Doom Pi Help$/m);
    expect(index).toContain('(./README.md)');
    expect(manifest.files).toEqual(expect.arrayContaining(['llms.txt', 'README.md']));
  });

  it('pins matching Pi peer and development versions', async () => {
    const manifest = await readManifest();

    expect(manifest.peerDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.3');
    expect(manifest.devDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.3');
  });
});
