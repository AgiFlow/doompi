import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDeclaredApi } from '../../src/adapters/testing/declaredApi.ts';
import type { DoomApi } from '../../src/schemas/packageApi.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A package on disk, shaped the way a published one is. */
function packageRoot(manifest?: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-api-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src', 'exports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'exports', 'hubApi.ts'), 'export const api = {}');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      manifest ?? {
        name: '@agimon-ai/demo',
        doompiApi: {
          basePath: 'demo',
          hub: { entry: './src/exports/hubApi.ts', dist: './dist/hubApi.mjs' },
        },
      },
    ),
  );
  return root;
}

function api(basePath: string): DoomApi {
  return {
    basePath,
    start: () => ({ fetch: () => new Response('ok'), close: () => undefined }),
  };
}

describe('a package API measured against the manifest that mounts it', () => {
  it('reports the base path and built module a host would mount', () => {
    const report = assertDeclaredApi({ packageRoot: packageRoot(), api: api('demo'), scope: 'hub' });

    expect(report).toEqual({ basePath: 'demo', scope: 'hub', dist: './dist/hubApi.mjs' });
  });

  it('catches a base path the routes and the manifest disagree about', () => {
    // The failure this exists for. Vibe-Lint reads the manifest statically and
    // cannot see the value, so nothing else in the repository notices.
    expect(() => assertDeclaredApi({ packageRoot: packageRoot(), api: api('renamed'), scope: 'hub' })).toThrow(
      "serves 'renamed' but its manifest mounts the hub API at 'demo'",
    );
  });

  it('catches an API asserted against a scope the manifest does not offer', () => {
    expect(() => assertDeclaredApi({ packageRoot: packageRoot(), api: api('demo'), scope: 'session' })).toThrow(
      'declares no session API',
    );
  });

  it('catches an export that is not an API at all', () => {
    const notAnApi = { basePath: '', start: 'nope' } as unknown as DoomApi;

    expect(() => assertDeclaredApi({ packageRoot: packageRoot(), api: notAnApi, scope: 'hub' })).toThrow(
      'not a DoomApi',
    );
  });

  it('reports the manifest error for a block naming no scope', () => {
    const root = packageRoot({ name: '@agimon-ai/demo', doompiApi: { basePath: 'demo' } });

    expect(() => assertDeclaredApi({ packageRoot: root, api: api('demo'), scope: 'hub' })).toThrow(
      'names neither a session nor a hub entry',
    );
  });
});
