import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  type?: string;
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
  keywords?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as PackageManifest;
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await access(path.join(packageRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

describe('doompi-web package contract', () => {
  it('is a public ESM package with an explicit publish allowlist', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-web');
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'llms.txt', 'README.md', 'package.json']));

    const keywords = manifest.keywords ?? [];
    expect(keywords).toEqual(expect.arrayContaining(['coding-agent', 'doompi', 'pi-coding-agent', 'web']));
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(keywords).toEqual(keywords.map((keyword) => keyword.toLowerCase()));
  });

  it('publishes exactly one executable with a closed export surface', async () => {
    const manifest = await readManifest();

    // The web package owns its command name and resolves the core server separately.
    expect(manifest.bin).toEqual({ 'doompi-web': './dist/bin/serve.mjs' });
    expect(manifest.exports).toEqual({
      '.': {
        types: './dist/index.d.mts',
        import: './dist/index.mjs',
        require: './dist/index.cjs',
      },
      './bundler': {
        types: './dist/bundler.d.mts',
        import: './dist/bundler.mjs',
        require: './dist/bundler.cjs',
      },
      './package.json': './package.json',
    });
  });

  it('builds computer-use before the browser fixture syncs the default composition', async () => {
    const workspaceRoot = path.resolve(packageRoot, '../../..');
    const workspace = JSON.parse(await readFile(path.join(workspaceRoot, 'package.json'), 'utf8')) as PackageManifest;
    expect(workspace.scripts?.['cockpit:build']?.split(/\s+/u)).toContain('@agimon-ai/doompi-computer-use');
  });

  it('ships the runtime the bridge and the sync-time bundler need', async () => {
    const manifest = await readManifest();
    const runtime = Object.keys(manifest.dependencies ?? {});

    // The web plugin system rebundles the SPA on the user's machine at
    // doompi sync time. That makes the client toolchain a runtime concern:
    // Vite, React, Tailwind, the browser protocol, plugin contracts, and the
    // shared component library ship with the presentation client. Headless
    // session, API, and authorization runtimes do not.
    expect(runtime).toEqual([
      '@agimon-ai/doompi',
      '@agimon-ai/doompi-extension-contracts',
      '@agimon-ai/doompi-web-components',
      '@agimon-ai/doompi-web-contracts',
      '@agimon-ai/doompi-web-security',
      '@codemirror/state',
      '@codemirror/view',
      '@earendil-works/chord',
      '@earendil-works/pi-client',
      '@simplewebauthn/browser',
      '@tailwindcss/vite',
      '@tanstack/react-router',
      '@tanstack/react-store',
      '@tanstack/store',
      '@vitejs/plugin-react',
      '@zxing/browser',
      'qrcode-generator',
      'react',
      'react-dom',
      'tailwindcss',
      'vite',
      'ws',
    ]);
    expect(manifest.dependencies?.['@agimon-ai/doompi']).toBe('workspace:*');
    // The bundler compiles src/web from the installed package, so the source
    // has to ship with it.
    expect(manifest.files).toEqual(expect.arrayContaining(['src']));
  });

  it('builds the server before the client so the bundle survives the clean', async () => {
    const manifest = await readManifest();
    expect(manifest.scripts?.build).toBe(
      'tsdown && vite build && vite build --config vite.pwa.config.ts && vite build --config vite.pwa.config.ts --mode worker',
    );
  });

  it('keeps the documents the manifest promises', async () => {
    for (const file of ['README.md', 'LICENSE', 'llms.txt']) {
      expect(await exists(file), `${file} is listed in files but missing`).toBe(true);
    }
  });
});
