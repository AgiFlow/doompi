// @scaffold-generated
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  bin?: Record<string, string>;
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

function localMarkdownReferences(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/gu)]
    .map((match) => match[1])
    .filter((reference): reference is string => Boolean(reference) && !/^[a-z][a-z0-9+.-]*:/iu.test(reference));
}

function isPublished(files: readonly string[], relativePath: string): boolean {
  return files.some((entry) => {
    const normalizedEntry = entry.replace(/\/+$/u, '');
    return relativePath === normalizedEntry || relativePath.startsWith(`${normalizedEntry}/`);
  });
}

describe('doompi-server package contract', () => {
  it('is a public ESM package with an explicit publish allowlist', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@agimon-ai/doompi-server');
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'llms.txt', 'README.md', 'package.json']));
    const keywords = manifest.keywords ?? [];
    expect(keywords).toEqual(expect.arrayContaining(['coding-agent', 'doompi', 'pi-coding-agent', 'session-server']));
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(keywords).toEqual(keywords.map((keyword) => keyword.toLowerCase()));
  });

  it('keeps a closed export surface and an executable entry', async () => {
    const manifest = await readManifest();
    const exportsMap = manifest.exports ?? {};

    expect(Object.keys(exportsMap)).toEqual(['.', './package.json']);
    expect(Object.keys(exportsMap)).not.toContain('./*');
    expect(conditions(exportsMap['.'])).toEqual(['types', 'import', 'require']);
    expect(manifest.pi).toBeUndefined();
    expect(manifest.bin).toEqual({ 'doompi-server': './dist/bin/serve.mjs' });
  });

  it('ships an H1-led Help index and every linked package resource', async () => {
    const manifest = await readManifest();
    const files = manifest.files ?? [];
    const index = await readFile(path.join(packageDirectory, 'llms.txt'), 'utf8');

    expect(index).toMatch(/^#\s+\S+/u);
    for (const reference of localMarkdownReferences(index)) {
      const relativePath = reference.replace(/^\.\//u, '');
      expect(isPublished(files, relativePath), relativePath).toBe(true);
      await expect(access(path.resolve(packageDirectory, relativePath)), relativePath).resolves.toBeUndefined();
    }
  });

  it('bundles the patched Pi protocol runtime into published artifacts', async () => {
    const [buildConfig, protocolPatch] = await Promise.all([
      readFile(path.join(packageDirectory, 'tsdown.config.ts'), 'utf8'),
      readFile(path.resolve(packageDirectory, '../../../patches/@earendil-works__pi-protocol@0.84.4.patch'), 'utf8'),
    ]);

    expect(buildConfig).toContain('unbundle: false');
    expect(buildConfig).toContain('alwaysBundle: [/^@earendil-works\\/pi-(?:protocol|server)(?:\\/|$)/u]');
    expect(protocolPatch).toContain('Check(ServerMessageContext, ServerMessageSchema, value)');
  });

  it('pins matching Pi peer and development versions', async () => {
    const manifest = await readManifest();

    expect(manifest.peerDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.4');
    expect(manifest.devDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.4');
  });
});
