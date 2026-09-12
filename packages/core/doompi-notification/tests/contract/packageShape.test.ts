import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { notificationExtension } from '../../src/extensions/pi';
import piEntry, { notificationExtension as piNamedEntry } from '../../src/extensions/pi';
import * as publicSurface from '../../src/exports';

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
  doompiServer?: { entry?: string; dist?: string; scopes?: string[] };
}

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
}

function conditions(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value);
}

describe('doompi-notification package contract', () => {
  it('is a public ESM package with an explicit publish allowlist', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-notification');
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'llms.txt', 'README.md', 'package.json']));
    expect(manifest.keywords).toEqual([
      'ai',
      'coding-agent',
      'desktop-notifications',
      'developer-tools',
      'doompi',
      'notifications',
      'pi-coding-agent',
      'pi-extension',
      'pi-package',
      'shell-title',
      'terminal-title',
    ]);
    expect(manifest.keywords).toEqual([...(manifest.keywords ?? [])].sort());
  });

  it('publishes Pi and server entries through a closed exports map', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};

    expect(Object.keys(exportsMap)).toEqual(['.', './extensions/pi', './extensions/server', './package.json']);
    expect(Object.keys(exportsMap)).not.toContain('./*');
    for (const subpath of ['.', './extensions/pi', './extensions/server']) {
      expect(conditions(exportsMap[subpath])).toEqual(['types', 'import', 'require']);
    }
    expect(manifest.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
    expect(manifest.doompiServer).toMatchObject({
      entry: './src/extensions/server.ts',
      dist: './dist/extensions/server.mjs',
      scopes: ['session'],
    });
  });

  it('routes the Pi entry through a default-exported factory', async () => {
    const entry = await readFile(path.join(packageDirectory, 'src/extensions/pi.ts'), 'utf8');

    expect(entry).toContain('definePiExtension');
    expect(entry).toContain('export default notificationExtension');
    expect(piEntry).toBe(notificationExtension);
    expect(piNamedEntry).toBe(notificationExtension);
  });

  it('re-exports the whole public surface through src/exports', () => {
    expect(Object.keys(publicSurface).sort()).toEqual([
      'askUserPromptBody',
      'attentionNotification',
      'createMainThreadTitleController',
      'createWorkerTitleController',
      'notificationBody',
      'promptTitle',
      'sendSystemNotification',
      'settledNotification',
      'shellTabTitle',
      'supportsShellTitle',
      'warrantsAttentionNotification',
      'warrantsSettledNotification',
    ]);
  });

  it('mounts its lifecycle under the shared Cordis host', async () => {
    const factory = await readFile(path.join(packageDirectory, 'src/extensions/pi.ts'), 'utf8');

    expect(factory).toContain('definePiExtension');
    expect(factory).not.toContain('new Context()');
    expect(factory).toContain('createNotificationRuntime');
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

    expect(index).toMatch(/^# Doom Pi Notification$/m);
    expect(index).toContain('(./README.md)');
    expect(manifest.files).toEqual(expect.arrayContaining(['llms.txt', 'README.md']));
  });

  it('pins matching Pi peer and development versions', async () => {
    const manifest = await readManifest();

    expect(manifest.peerDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.85.1');
    expect(manifest.devDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.85.1');
  });
});
