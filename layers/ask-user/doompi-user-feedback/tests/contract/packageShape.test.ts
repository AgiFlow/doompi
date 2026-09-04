import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  private?: boolean;
  type?: string;
  files?: string[];
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
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

describe('doompi-user-feedback package contract', () => {
  it('is a public package with an explicit publish allowlist', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-user-feedback');
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'README.md', 'LICENSE', 'package.json']));
  });

  it('keeps closed ESM, CJS, declaration, and Pi exports', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};

    expect(Object.keys(exportsMap)).toEqual(['.', './extensions/pi', './package.json']);
    expect(Object.keys(exportsMap)).not.toContain('./*');
    for (const subpath of ['.', './extensions/pi']) {
      expect(conditions(exportsMap[subpath])).toEqual(['types', 'import', 'require']);
    }
    expect(manifest.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
    expect(await readFile(path.join(packageDirectory, 'src/exports/index.ts'), 'utf8')).not.toContain(
      'registerUserFeedbackExtension',
    );
    expect(await readFile(path.join(packageDirectory, 'src/exports/extensions/pi.ts'), 'utf8')).not.toMatch(
      /Symbol\.for|installed-hosts|WeakSet/u,
    );
  });

  it('has no Juicesharp dependency and pins the Pi boundary', async () => {
    const manifest = await readManifest();

    expect(Object.keys(manifest.dependencies ?? {}).some((name) => name.startsWith('@juicesharp/'))).toBe(false);
    expect(manifest.dependencies).toMatchObject({
      '@agimon-ai/doompi-extension-contracts': 'workspace:*',
      '@deepseek-ai/cordis': '4.0.1',
      typebox: '1.3.19',
    });
    for (const packageName of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
      expect(manifest.peerDependencies?.[packageName]).toBe('0.85.0');
      expect(manifest.devDependencies?.[packageName]).toBe('0.85.0');
    }
  });
});
