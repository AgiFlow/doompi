import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncWebBundle } from '../../src/adapters/webBundleSync.ts';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A stand-in installed doompi-web: package.json plus a bundler entry file. */
function fakeWebPackage(): string {
  const root = tempDir('doompi-webpkg-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@agimon-ai/doompi-web' }));
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'bundler.mjs'), 'export const marker = true;');
  return root;
}

describe('the sync web bundle phase', () => {
  it('skips with a reason when doompi-web is not installed', async () => {
    const result = await syncWebBundle({
      repoRoot: tempDir('doompi-repo-'),
      resolvedEntries: {},
      environment: {},
      outputDirectory: tempDir('doompi-generation-web-'),
      // Native require resolution consults machine-wide paths, so the
      // not-installed case is pinned through the seam.
      resolveWebRoot: () => undefined,
    });
    expect(result).toMatchObject({ status: 'skipped' });
  });

  it('derives plugin roots from resolved entries, bundles, and swaps current atomically', async () => {
    const webRoot = fakeWebPackage();
    const home = tempDir('doompi-home-');
    const pluginRoot = tempDir('doompi-plugin-');
    fs.writeFileSync(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: 'plugin' }));
    fs.mkdirSync(path.join(pluginRoot, 'dist', 'extensions'), { recursive: true });
    const entry = path.join(pluginRoot, 'dist', 'extensions', 'pi.mjs');
    fs.writeFileSync(entry, '');

    const calls: Array<{ pluginRoots: readonly string[]; outDir: string }> = [];
    const outputDirectory = path.join(home, 'generation', 'web-bundle');
    const result = await syncWebBundle({
      repoRoot: tempDir('doompi-repo-'),
      resolvedEntries: { a: entry, b: entry },
      environment: { DOOMPI_WEB_PACKAGE_ROOT: webRoot },
      outputDirectory,
      importBundler: () =>
        Promise.resolve({
          bundleCockpitWeb: (options: { pluginRoots: readonly string[]; outDir: string }) => {
            calls.push(options);
            const assetsDir = path.join(options.outDir, 'web');
            fs.mkdirSync(assetsDir, { recursive: true });
            fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html>');
            return Promise.resolve({ assetsDir, pluginIds: ['subagents', 'workflows'] });
          },
        }),
    });

    // Duplicate entries collapse to one package root.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pluginRoots).toEqual([pluginRoot]);
    expect(result).toMatchObject({ status: 'bundled', pluginIds: ['subagents', 'workflows'] });
    const generated = path.join(outputDirectory, 'web', 'index.html');
    expect(fs.existsSync(generated)).toBe(true);
    if (result.status === 'bundled') expect(result.assetsDir).toBe(path.dirname(generated));
  });

  it('reports a bundler failure without leaving a broken current bundle', async () => {
    const webRoot = fakeWebPackage();
    const home = tempDir('doompi-home-');
    const outputDirectory = path.join(home, 'generation', 'web-bundle');
    const result = await syncWebBundle({
      repoRoot: tempDir('doompi-repo-'),
      resolvedEntries: {},
      environment: { DOOMPI_WEB_PACKAGE_ROOT: webRoot },
      outputDirectory,
      importBundler: () => Promise.reject(new Error('vite exploded')),
    });
    expect(result).toEqual({ status: 'failed', reason: 'vite exploded' });
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });
});
