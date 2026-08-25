import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { declaredApisOf, DoomApiManifestError, isDoomApi, orderDeclaredApis } from '../src/schemas/packageApi.ts';
import { loadPackageApis, packageApiModulePath } from '../src/adapters/packageApiLoader.ts';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const session = { entry: './src/exports/sessionApi.ts', dist: './dist/sessionApi.mjs' };
const hub = { entry: './src/exports/hubApi.ts', dist: './dist/hubApi.mjs' };

const declare = (block: Record<string, unknown>, dir = '/a'): ReturnType<typeof declaredApisOf> =>
  declaredApisOf(dir, { name: 'demo', doompiApi: { basePath: 'demo', ...block } });

describe('the doompiApi manifest vocabulary', () => {
  it('is absent for a package that declares nothing', () => {
    expect(declaredApisOf('/a', { name: 'demo' })).toEqual([]);
  });

  it('reads either scope, or both', () => {
    const sessionOnly = declare({ session })[0];
    expect(sessionOnly).toMatchObject({ basePath: 'demo', session });
    expect(sessionOnly?.hub).toBeUndefined();
    expect(declare({ hub })[0]).toMatchObject({ basePath: 'demo', hub });
    const both = declare({ session, hub })[0];
    expect(both?.session).toEqual(session);
    expect(both?.hub).toEqual(hub);
  });

  it('normalizes a bare path into an entry', () => {
    expect(() => declare({ session: './src/exports/sessionApi.ts' })).toThrow(/session\.dist is required/u);
  });

  it('rejects a block that no host could ever mount', () => {
    expect(() => declare({})).toThrow(/names neither a session nor a hub entry/u);
  });

  it('rejects a base path that is not kebab-case', () => {
    expect(() => declaredApisOf('/a', { doompiApi: { basePath: 'Not Kebab', session } })).toThrow(DoomApiManifestError);
  });

  it('rejects a path that could reach outside the package', () => {
    expect(() => declare({ session: { entry: '../evil.ts', dist: './dist/x.mjs' } })).toThrow(
      /session\.entry must be a package-relative/u,
    );
    expect(() => declare({ session: { entry: './src/x.ts', dist: '../../evil.mjs' } })).toThrow(
      /session\.dist must be a package-relative/u,
    );
  });

  it('requires a built entry, because a host imports what the package ships and never its source', () => {
    expect(() => declare({ hub: { entry: './src/exports/hubApi.ts' } })).toThrow(/hub\.dist is required/u);
  });

  it('reads an array of blocks, so one package may serve several base paths', () => {
    const declared = declaredApisOf('/a', {
      name: 'demo',
      doompiApi: [
        { basePath: 'one', session },
        { basePath: 'two', hub },
      ],
    });
    expect(declared.map((api) => api.basePath)).toEqual(['one', 'two']);
  });

  it('lets the first package keep a contested base path, with a notice', () => {
    const notices: string[] = [];
    const kept = orderDeclaredApis(
      [
        { basePath: 'demo', packageDir: '/b', packageName: 'b', session },
        { basePath: 'demo', packageDir: '/a', packageName: 'a', session },
      ],
      (message) => notices.push(message),
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.packageDir).toBe('/a');
    expect(notices[0]).toMatch(/'demo' from \/b is skipped/u);
  });
});

describe('narrowing a module export to an API', () => {
  it('accepts a base path and a start function, and nothing else', () => {
    expect(isDoomApi({ basePath: 'demo', start: () => undefined })).toBe(true);
    expect(isDoomApi({ basePath: '', start: () => undefined })).toBe(false);
    expect(isDoomApi({ basePath: 'demo' })).toBe(false);
    expect(isDoomApi(undefined)).toBe(false);
  });
});

function generated(source: string): { homeDir: string } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-api-home-'));
  cleanups.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const dir = path.join(homeDir, '.doompi', 'api', 'current');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.routes.mjs'), source);
  return { homeDir };
}

const validApi = (basePath: string): string =>
  `{ basePath: '${basePath}', start: () => ({ fetch: () => new Response('ok'), close() {} }) }`;

describe('loading the generated route module', () => {
  it('names the module a host of each scope imports', () => {
    expect(packageApiModulePath('session', {}, '/home/x')).toBe('/home/x/.doompi/api/current/session.routes.mjs');
    expect(packageApiModulePath('hub', {}, '/home/x')).toBe('/home/x/.doompi/api/current/hub.routes.mjs');
  });

  it('mounts nothing before anything is synced, without complaining', async () => {
    const notices: string[] = [];
    const apis = await loadPackageApis('session', {
      homeDir: '/nonexistent-home',
      env: {},
      onNotice: (message) => notices.push(message),
    });
    expect(apis).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('loads what the module exports', async () => {
    const { homeDir } = generated(`export const apis = [${validApi('runner')}];`);
    const apis = await loadPackageApis('session', { homeDir, env: {} });
    expect(apis.map((api) => api.basePath)).toEqual(['runner']);
  });

  it('turns a module that fails to load into a notice, never a refusal to start', async () => {
    const { homeDir } = generated('import "node:nonexistent-module";');
    const notices: string[] = [];
    const apis = await loadPackageApis('session', { homeDir, env: {}, onNotice: (m) => notices.push(m) });
    expect(apis).toEqual([]);
    expect(notices.join('\n')).toMatch(/session package APIs are unavailable/u);
  });

  it('skips an export that is not an API', async () => {
    const { homeDir } = generated(`export const apis = [{ nope: true }, ${validApi('runner')}];`);
    const notices: string[] = [];
    const apis = await loadPackageApis('session', { homeDir, env: {}, onNotice: (m) => notices.push(m) });
    expect(apis.map((api) => api.basePath)).toEqual(['runner']);
    expect(notices.join('\n')).toMatch(/is not a package API/u);
  });

  it('reports a module that exports no list at all', async () => {
    const { homeDir } = generated('export const apis = "not a list";');
    const notices: string[] = [];
    expect(await loadPackageApis('session', { homeDir, env: {}, onNotice: (m) => notices.push(m) })).toEqual([]);
    expect(notices.join('\n')).toMatch(/exports no apis array/u);
  });

  it('keeps the first claim on a base path, because a mount point is global', async () => {
    const { homeDir } = generated(`export const apis = [${validApi('runner')}, ${validApi('runner')}];`);
    const notices: string[] = [];
    const apis = await loadPackageApis('session', { homeDir, env: {}, onNotice: (m) => notices.push(m) });
    expect(apis).toHaveLength(1);
    expect(notices.join('\n')).toMatch(/duplicate package API base path 'runner'/u);
  });
});
