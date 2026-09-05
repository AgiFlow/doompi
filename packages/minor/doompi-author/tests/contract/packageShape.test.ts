import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  exports?: Record<string, unknown>;
  doompiApi?: { basePath?: string; session?: { entry?: string } };
  doompiWeb?: { pluginId?: string; channels?: string[]; client?: string; hub?: { entry?: string } };
  pi?: { extensions?: string[] };
}

async function manifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
}

describe('doompi-author package contract', () => {
  it('is a private foundation package with closed entries', async () => {
    const value = await manifest();
    expect(value).toMatchObject({ name: '@agimon-ai/doompi-author', version: '0.0.0', private: true });
    expect(Object.keys(value.exports ?? {})).toEqual([
      '.',
      './extensions/pi',
      './session-api',
      './web-hub',
      './package.json',
    ]);
    expect(value.pi?.extensions).toEqual(['./dist/extensions/pi.mjs']);
  });

  it('declares matching package API and web entries', async () => {
    const value = await manifest();
    expect(value.doompiApi).toEqual({
      basePath: 'author',
      session: { entry: './src/exports/sessionApi.ts', dist: './dist/sessionApi.mjs' },
    });
    expect(value.doompiWeb).toMatchObject({
      pluginId: 'author',
      channels: ['author_webmcp'],
      client: './src/exports/webClient.ts',
      hub: { entry: './src/exports/webHub.ts', dist: './dist/webHub.mjs' },
    });
    expect(value.files).toEqual(expect.arrayContaining(['dist', 'src/web', 'src/prompts', 'llms.txt', 'README.md']));
  });
});
