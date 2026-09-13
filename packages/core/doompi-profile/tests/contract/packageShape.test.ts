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

describe('doompi-profile package contract', () => {
  it('is a public ESM package with an explicit publish allowlist', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-profile');
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        'dist',
        'src/web',
        'src/extensions/web.ts',
        'llms.txt',
        'README.md',
        'src/prompts',
        'package.json',
      ]),
    );
    expect(manifest.keywords).toEqual([
      'agent-persona',
      'ai',
      'coding-agent',
      'developer-tools',
      'doompi',
      'pi-coding-agent',
      'pi-extension',
      'pi-package',
      'profile-switching',
      'system-prompt',
    ]);
  });

  it('publishes the command entry through pi.extensions and persona as an explicit subpath', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};

    expect(Object.keys(exportsMap)).toEqual([
      '.',
      './extensions/persona',
      './extensions/pi',
      './extensions/server',
      './package.json',
    ]);
    expect(Object.keys(exportsMap)).not.toContain('./*');
    expect(Object.keys(exportsMap)).not.toContain('./extensions/doom');
    for (const subpath of ['.', './extensions/persona', './extensions/pi', './extensions/server']) {
      expect(conditions(exportsMap[subpath])).toEqual(['types', 'import', 'require']);
    }
    // Only the command entry is discovered by a bare package name. Detached
    // children load ./extensions/persona by explicit subpath instead, because
    // they have no transition coordinator to run a switch through.
    expect(manifest.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
  });

  it('declares the cockpit profile axis as its web plugin', async () => {
    const manifest = await readManifest();

    expect(manifest.doompiWeb).toEqual({
      pluginId: 'profile',
      channels: [],
      client: './src/extensions/web.ts',
      scopes: ['session'],
    });
    const client = await readFile(path.join(packageDirectory, 'src/extensions/web.ts'), 'utf8');
    expect(client).toContain('defineWebPlugin');
    const entry = client;
    expect(entry).toContain('defineWebPlugin');
    expect(entry).toContain("statusKey: 'doom-profile'");
  });

  it('uses the shared core package for runtime and web capabilities', async () => {
    const manifest = await readManifest();
    expect(manifest.dependencies?.['@agimon-ai/doompi-core']).toBe('workspace:*');
  });

  it('routes both Pi entries through a default-exported factory', async () => {
    const commandEntry = await readFile(path.join(packageDirectory, 'src/extensions/pi.ts'), 'utf8');
    const personaEntry = await readFile(path.join(packageDirectory, 'src/extensions/persona.ts'), 'utf8');
    const factory = await readFile(path.join(packageDirectory, 'src/controllers/profileRuntime.ts'), 'utf8');

    expect(commandEntry).toContain('definePiExtension');
    expect(commandEntry).toContain('export default profileExtension');
    expect(personaEntry).toContain('export default personaExtension');
    expect(factory).toContain('createProfileCommand');
    expect(factory).toContain('services: [bindRuntime, bindVoice]');
    expect(factory).toContain('events:');
    expect(commandEntry).toContain("name: 'doompi-author-profile'");
    expect(commandEntry).toContain('moduleUrl: import.meta.url');
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
    const skillPath = 'src/prompts/doompi-author-profile/SKILL.md';
    const referencePath = 'src/prompts/doompi-author-profile/references/profiles-contract.md';

    expect(index).toMatch(/^# Doom Pi Profile$/m);
    expect(index).toContain('(./README.md)');
    expect(index).toContain(`(./${skillPath})`);
    expect(index).toContain(`(./${referencePath})`);
    expect(manifest.files).toEqual(expect.arrayContaining(['llms.txt', 'README.md', 'src/prompts']));
    await expect(readFile(path.join(packageDirectory, skillPath), 'utf8')).resolves.toMatch(
      /^---\nname: doompi-author-profile$/m,
    );
    await expect(readFile(path.join(packageDirectory, referencePath), 'utf8')).resolves.toMatch(
      /^# DoomPi profiles authoring contract$/m,
    );
  });

  it('pins matching Pi peer and development versions', async () => {
    const manifest = await readManifest();

    for (const pi of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
      expect(manifest.peerDependencies?.[pi]).toBe('0.85.1');
      expect(manifest.devDependencies?.[pi]).toBe('0.85.1');
    }
  });
});
