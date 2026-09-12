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
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
  doompiWeb?: { pluginId?: string; registrationOrder?: number; channels?: string[]; client?: string };
}

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
}

function conditions(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value);
}

describe('doompi-domain package contract', () => {
  it('is a public ESM package with an explicit publish allowlist', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-domain');
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        'dist',
        'src/web',
        'src/extensions/web.ts',
        'llms.txt',
        'src/prompts',
        'README.md',
        'package.json',
      ]),
    );
    expect(manifest.keywords).toEqual([
      'ai',
      'coding-agent',
      'developer-tools',
      'domains',
      'doompi',
      'mcp',
      'pi-coding-agent',
      'pi-extension',
      'pi-package',
      'plugins',
      'session-reload',
      'skills',
    ]);
    expect([...(manifest.keywords ?? [])].sort()).toEqual(manifest.keywords);
  });

  it('publishes the staging subpaths the launcher imports back, and no wildcard', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};

    expect(Object.keys(exportsMap)).toEqual([
      '.',
      './apply',
      './extensions/pi',
      './extensions/server',
      './mcp',
      './plugins',
      './resources',
      './package.json',
    ]);
    expect(Object.keys(exportsMap)).not.toContain('./*');
    for (const subpath of [
      '.',
      './apply',
      './extensions/pi',
      './extensions/server',
      './mcp',
      './plugins',
      './resources',
    ]) {
      expect(conditions(exportsMap[subpath]), subpath).toEqual(['types', 'import', 'require']);
    }
    expect(manifest.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
  });

  it('declares the cockpit domains axis as its web plugin', async () => {
    const manifest = await readManifest();

    expect(manifest.doompiWeb).toEqual({
      pluginId: 'domain',
      channels: [],
      client: './src/extensions/web.ts',
      scopes: ['session'],
    });
    const client = await readFile(path.join(packageDirectory, 'src/extensions/web.ts'), 'utf8');
    expect(client).toContain('export const webPlugin = defineWebPlugin');
    const entry = client;
    expect(entry).toContain('defineWebPlugin');
    expect(entry).toContain("statusKey: 'doom-domain'");
    expect(entry).toContain('multi: true');
  });

  it('keeps the web contract optional for headless installs while supporting web builds', async () => {
    const manifest = await readManifest();

    expect(manifest.dependencies?.['@agimon-ai/doompi-web-contracts']).toBeUndefined();
    expect(manifest.devDependencies?.['@agimon-ai/doompi-web-contracts']).toBe('workspace:*');
    expect(manifest.peerDependencies?.['@agimon-ai/doompi-web-contracts']).toBe('workspace:*');
    expect(manifest.peerDependenciesMeta?.['@agimon-ai/doompi-web-contracts']).toEqual({ optional: true });
  });

  it('routes Pi discovery through the command and voice-tool factory', async () => {
    const entry = await readFile(path.join(packageDirectory, 'src/extensions/pi.ts'), 'utf8');
    const factory = await readFile(path.join(packageDirectory, 'src/controllers/domainRuntime.ts'), 'utf8');

    expect(entry).toContain('definePiExtension');
    expect(entry).toContain('export default domainsExtension');
    expect(factory).toContain('createDomainsCommand');
    expect(factory).toContain('registerDomainVoiceCapabilities');
    expect(factory).toContain('services:');
    expect(factory).toContain('commands:');
    expect(entry).toContain('resources:');
    expect(factory).toContain('inject([DOOM_CONFIG_SERVICE, DOOM_TRANSITION_SERVICE]');
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
  });

  it('ships an H1-led Help index whose linked resources are allowlisted', async () => {
    const manifest = await readManifest();
    const index = await readFile(path.join(packageDirectory, 'llms.txt'), 'utf8');

    expect(index).toMatch(/^# Doom Pi Domain$/m);
    expect(index).toContain('(./README.md)');
    expect(index).toContain('(./src/prompts/doompi-author-domain/SKILL.md)');
    expect(index).toContain('(./src/prompts/doompi-author-domain/references/domains-contract.md)');
    expect(manifest.files).toEqual(expect.arrayContaining(['llms.txt', 'src/prompts', 'README.md']));

    for (const match of index.matchAll(/\]\((\.\/[^)]+)\)/gu)) {
      expect(await readFile(path.join(packageDirectory, match[1]!), 'utf8'), match[1]).not.toHaveLength(0);
    }
  });

  it('pins matching Pi peer and development versions', async () => {
    const manifest = await readManifest();

    for (const pi of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
      expect(manifest.peerDependencies?.[pi]).toBe('0.85.1');
      expect(manifest.devDependencies?.[pi]).toBe('0.85.1');
    }
  });
});
