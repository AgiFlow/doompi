import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

interface PackageManifest {
  name: string;
  private?: boolean;
  type?: string;
  files?: string[];
  keywords?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: { access?: string };
  doompiServer?: { entry?: string; dist?: string; scopes?: string[] };
  doompiWeb?: { pluginId?: string; channels?: string[]; client?: string; hub?: { entry?: string } };
  pi?: { extensions?: string[] };
}

async function manifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
}

describe('doompi-author package contract', () => {
  it('is a public ESM package with closed entries', async () => {
    const value = await manifest();
    expect(value.name).toBe('@agimon-ai/doompi-author');
    expect(value.private).toBeUndefined();
    expect(value.type).toBe('module');
    expect(value.publishConfig).toEqual({ access: 'public' });
    expect(value.keywords).toEqual(
      expect.arrayContaining([
        'authoring',
        'coding-agent',
        'doompi',
        'pi-coding-agent',
        'pi-extension',
        'pi-package',
        'typescript',
      ]),
    );
    expect(Object.keys(value.exports ?? {})).toEqual([
      '.',
      './extensions/pi',
      './extensions/server',
      './package.json',
      './author-facade',
    ]);
    expect(value.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
  });

  it('declares matching server facet and web entries', async () => {
    const value = await manifest();
    expect('doompiApi' in value).toBe(false);
    expect(value.doompiServer).toEqual({
      entry: './src/extensions/server.ts',
      dist: './dist/extensions/server.mjs',
      scopes: ['global', 'workspace', 'session'],
    });
    expect(value.doompiWeb).toMatchObject({
      pluginId: 'author',
      channels: ['author_webmcp'],
      client: './src/extensions/web.ts',
    });
    expect(value.doompiWeb?.hub).toBeUndefined();
    expect(value.files).toEqual(expect.arrayContaining(['dist', 'src/web', 'src/prompts', 'llms.txt', 'README.md']));
  });
});
