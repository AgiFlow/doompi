import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DoomApi, DoomApiContext } from '../../src/schemas/packageApi.ts';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerFacet } from '../../src/schemas/serverFacet.ts';
import { createDoomServerHost } from '../../src/services/serverFacet.ts';
import { installServerFacets, loadServerFacets, serverFacetsModulePath } from '../../src/adapters/serverFacetLoader.ts';

function hostFor(scope: 'session' | 'hub' = 'session', onNotice: (message: string) => void = vi.fn()) {
  const context: DoomApiContext = { scope, sessionId: 'session-1', cwd: '/repo', onNotice };
  return createDoomServerHost({ scope, context });
}

function apiNamed(basePath: string): DoomApi {
  return { basePath, start: () => ({ fetch: () => new Response(basePath), close: () => undefined }) };
}

function facetRegistering(basePath: string): DoomServerFacet {
  return {
    inject: [DOOM_SERVER_HOST_SERVICE],
    apply(context) {
      const host = context.get(DOOM_SERVER_HOST_SERVICE);
      if (!host) throw new Error('no host');
      const registration = host.registerApi(apiNamed(basePath));
      return () => registration.dispose();
    },
  };
}

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doom-facets-'));
}

describe('installServerFacets', () => {
  it('leaves the mount table complete once it resolves', async () => {
    const host = hostFor();

    await installServerFacets({ host, facets: [facetRegistering('runner'), facetRegistering('voice-media')] });

    expect(host.mounted()).toEqual(['runner', 'voice-media']);
  });

  it('unwinds every facet registration on dispose', async () => {
    const host = hostFor();
    const installed = await installServerFacets({ host, facets: [facetRegistering('runner')] });

    await installed.dispose();

    expect(host.mounted()).toEqual([]);
  });

  it('reports a facet whose apply throws and keeps installing the rest', async () => {
    const notices: string[] = [];
    const host = hostFor();
    const broken: DoomServerFacet = {
      apply() {
        throw new Error('bad facet');
      },
    };

    await installServerFacets({
      host,
      facets: [broken, facetRegistering('runner')],
      onNotice: (message) => notices.push(message),
    });

    expect(host.mounted()).toEqual(['runner']);
    expect(notices).toEqual(['a server facet did not install (bad facet)']);
  });
});

describe('loadServerFacets', () => {
  it('resolves the module beside the generated route modules', () => {
    expect(serverFacetsModulePath('hub', {}, '/home/dev', '/gen/api')).toBe(path.resolve('/gen/api', 'hub.facets.mjs'));
  });

  it('returns nothing when the module has not been synced', async () => {
    expect(await loadServerFacets('session', { apiDirectory: temporaryDirectory(), env: {} })).toEqual([]);
  });

  it('loads the facets a sync generation wrote', async () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(
      path.join(directory, 'session.facets.mjs'),
      'export const facets = [{ apply: () => undefined }, { apply: () => undefined }];\n',
    );

    expect(await loadServerFacets('session', { apiDirectory: directory, env: {} })).toHaveLength(2);
  });

  it('skips an entry that is not a facet', async () => {
    const notices: string[] = [];
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, 'session.facets.mjs'), 'export const facets = [{ apply: 1 }];\n');

    expect(
      await loadServerFacets('session', { apiDirectory: directory, env: {}, onNotice: (m) => notices.push(m) }),
    ).toEqual([]);
    expect(notices).toEqual(['a session facet entry is not a server facet and is skipped']);
  });

  it('reports a module exporting no facets array', async () => {
    const notices: string[] = [];
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, 'hub.facets.mjs'), 'export const facets = 3;\n');

    expect(
      await loadServerFacets('hub', { apiDirectory: directory, env: {}, onNotice: (m) => notices.push(m) }),
    ).toEqual([]);
    expect(notices[0]).toContain('exports no facets array');
  });

  it('reports a module that fails to load rather than refusing to start', async () => {
    const notices: string[] = [];
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, 'hub.facets.mjs'), 'throw new Error("boom");\n');

    expect(
      await loadServerFacets('hub', { apiDirectory: directory, env: {}, onNotice: (m) => notices.push(m) }),
    ).toEqual([]);
    expect(notices).toEqual(['hub server facets are unavailable (boom)']);
  });
});
