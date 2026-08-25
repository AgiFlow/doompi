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

  it('publishes exactly the web and server executables with a closed export surface', async () => {
    const manifest = await readManifest();

    expect(manifest.bin).toEqual({
      'doompi-server': './dist/bin/server.mjs',
      'doompi-web': './dist/bin/serve.mjs',
    });
    expect(Object.keys(manifest.exports ?? {})).toEqual(['.', './bundler', './package.json']);
  });

  it('ships the runtime the bridge and the sync-time bundler need', async () => {
    const manifest = await readManifest();
    const runtime = Object.keys(manifest.dependencies ?? {});

    // The web plugin system rebundles the SPA on the user's machine at
    // doompi sync time, against whatever plugin packages the composition
    // installed. That makes the client toolchain a runtime concern: the
    // bundler subpath must work from an installed package, so Vite, React,
    // Tailwind, the TanStack runtimes, the plugin contracts, and the shared
    // component library ship as dependencies alongside the hono trio. Web is
    // also the user-facing distribution, so it ships the DoomPi agent and
    // Server client needed by its two commands. Plugin packages are still
    // discovered from manifests rather than depended on.
    expect(runtime).toEqual([
      '@agimon-ai/doompi',
      '@agimon-ai/doompi-extension-contracts',
      '@agimon-ai/doompi-server',
      '@agimon-ai/doompi-web-components',
      '@agimon-ai/doompi-web-contracts',
      '@earendil-works/pi-coding-agent',
      '@hono/node-server',
      '@hono/node-ws',
      '@tailwindcss/vite',
      '@tanstack/react-router',
      '@tanstack/react-store',
      '@tanstack/store',
      '@vitejs/plugin-react',
      'hono',
      'react',
      'react-dom',
      'react-markdown',
      'remark-gfm',
      'tailwindcss',
      'vite',
    ]);
    expect(manifest.dependencies?.['@agimon-ai/doompi']).toBe('workspace:*');
    expect(manifest.dependencies?.['@agimon-ai/doompi-server']).toBe('workspace:*');
    // The bundler compiles src/web from the installed package, so the source
    // has to ship with it.
    expect(manifest.files).toEqual(expect.arrayContaining(['src']));
  });

  it('builds the server before the client so the bundle survives the clean', async () => {
    const manifest = await readManifest();
    expect(manifest.scripts?.build).toBe('tsdown && vite build');
  });

  it('keeps the documents the manifest promises', async () => {
    for (const file of ['README.md', 'LICENSE', 'llms.txt']) {
      expect(await exists(file), `${file} is listed in files but missing`).toBe(true);
    }
  });
});
