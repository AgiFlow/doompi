import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOOM_SERVER_BUNDLE_FILE,
  type DoomServerBundleEntry,
  parseDoomServerBundle,
} from '../../src/schemas/serverBundle.ts';
import type { DoomApi, DoomApiContext } from '../../src/schemas/packageApi.ts';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerFacet } from '../../src/schemas/serverFacet.ts';
import { createDoomServerHost } from '../../src/services/serverFacet.ts';
import {
  installServerFacets,
  type LoadedServerFacet,
  loadServerBundle,
  loadServerFacets,
  serverFacetsModulePath,
} from '../../src/adapters/serverFacetLoader.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function hostFor(scope: 'session' | 'hub' = 'session', onNotice: (message: string) => void = vi.fn()) {
  const context: DoomApiContext = { scope, sessionId: 'session-1', cwd: '/repo', onNotice };
  return createDoomServerHost({ scope, context });
}

function apiNamed(basePath: string, close: () => void = () => undefined): DoomApi {
  return { basePath, start: () => ({ fetch: () => new Response(basePath), close }) };
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-facets-'));
  directories.push(directory);
  return directory;
}

function loadedFacet(packageName: string, facet: DoomServerFacet, required = false): LoadedServerFacet {
  return {
    declaration: {
      packageName,
      entry: './src/exports/extensions/server.ts',
      module: `./${packageName}.mjs`,
      scopes: ['session'],
      owners: [{ majorMode: 'coding', layer: 'tools' }],
      required,
    },
    facet,
  };
}

describe('installServerFacets', () => {
  it('rejects retained candidates before applying them without a gated host', async () => {
    const host = hostFor();
    const apply = vi.fn();
    try {
      await expect(
        installServerFacets({ host, facets: [{ ...loadedFacet('retained', { apply }), retained: true }] }),
      ).rejects.toThrow('require a gated headless host');
      expect(apply).not.toHaveBeenCalled();
      expect(host.mounted()).toEqual([]);
    } finally {
      host.dispose();
    }
  });
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

  it('rejects a required facet when its API cannot start', async () => {
    const host = hostFor();
    const required = loadedFacet(
      'required-unavailable',
      {
        inject: [DOOM_SERVER_HOST_SERVICE],
        apply(context) {
          const server = context.get(DOOM_SERVER_HOST_SERVICE);
          if (!server) throw new Error('no host');
          const registration = server.registerApi({
            basePath: 'unavailable',
            start() {
              throw new Error('no socket');
            },
          });
          return () => registration.dispose();
        },
      },
      true,
    );

    await expect(installServerFacets({ host, facets: [required] })).rejects.toThrow(
      "server facet 'required-unavailable' did not install",
    );
    expect(host.mounted()).toEqual([]);
  });

  it('cleans up an optional facet API when apply throws after registering it', async () => {
    const notices: string[] = [];
    const close = vi.fn();
    const host = hostFor();
    const optional = loadedFacet('optional-leaked', {
      inject: [DOOM_SERVER_HOST_SERVICE],
      apply(context) {
        const server = context.get(DOOM_SERVER_HOST_SERVICE);
        if (!server) throw new Error('no host');
        server.registerApi(apiNamed('leaked', close));
        throw new Error('bad after registration');
      },
    });

    const installed = await installServerFacets({
      host,
      facets: [optional, facetRegistering('healthy')],
      onNotice: (message) => notices.push(message),
    });

    expect(host.mounted()).toEqual(['healthy']);
    expect(notices).toEqual(["server facet 'optional-leaked' did not install (bad after registration)"]);
    expect(close).toHaveBeenCalledTimes(1);
    await installed.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(host.mounted()).toEqual([]);
  });

  it('attributes optional bundle failures and disposes the failed fiber', async () => {
    const notices: string[] = [];
    const cleanup = vi.fn();
    const host = hostFor();
    const optional = loadedFacet('optional-broken', {
      apply(context) {
        context.effect(() => cleanup);
        throw new Error('bad optional facet');
      },
    });

    const installed = await installServerFacets({
      host,
      facets: [optional, facetRegistering('healthy')],
      onNotice: (message) => notices.push(message),
    });

    expect(host.mounted()).toEqual(['healthy']);
    expect(notices).toEqual(["server facet 'optional-broken' did not install (bad optional facet)"]);
    expect(cleanup).toHaveBeenCalledTimes(1);

    await installed.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects required bundle failures after disposing installed work', async () => {
    const cleanup = vi.fn();
    const host = hostFor();
    const required = loadedFacet(
      'required-broken',
      {
        apply(context) {
          context.effect(() => cleanup);
          throw new Error('bad required facet');
        },
      },
      true,
    );

    await expect(installServerFacets({ host, facets: [facetRegistering('healthy'), required] })).rejects.toThrow(
      "server facet 'required-broken' did not install (bad required facet)",
    );

    expect(host.mounted()).toEqual([]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('disposes successful bundle facets in reverse install order', async () => {
    const events: string[] = [];
    const installed = await installServerFacets({
      host: hostFor(),
      facets: [
        loadedFacet('first', {
          apply() {
            events.push('apply:first');
            return () => events.push('dispose:first');
          },
        }),
        loadedFacet('second', {
          apply() {
            events.push('apply:second');
            return () => events.push('dispose:second');
          },
        }),
      ],
    });

    expect(events).toEqual(['apply:first', 'apply:second']);
    await installed.dispose();
    await installed.dispose();
    expect(events).toEqual(['apply:first', 'apply:second', 'dispose:second', 'dispose:first']);
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

describe('loadServerBundle', () => {
  const fingerprint = 'a'.repeat(64);
  const entry = (packageName: string, overrides: Partial<DoomServerBundleEntry> = {}): DoomServerBundleEntry => ({
    packageName,
    entry: './src/exports/extensions/server.ts',
    module: `./${packageName}.mjs`,
    scopes: ['session'],
    owners: [{ majorMode: 'coding', layer: 'tools' }],
    required: false,
    ...overrides,
  });
  function bundle(entries: readonly DoomServerBundleEntry[]) {
    const directory = temporaryDirectory();
    const descriptor = { version: 1, generation: 'generation-1', fingerprint, entries };
    const descriptorFile = path.join(directory, DOOM_SERVER_BUNDLE_FILE);
    fs.writeFileSync(descriptorFile, JSON.stringify(descriptor));
    return {
      directory,
      descriptor,
      descriptorFile,
      options: { directory, generation: 'generation-1', fingerprint, majorMode: 'coding', activeLayers: ['tools'] },
    };
  }

  it.each(['session', 'hub'] as const)(
    'admits default packages for %s without named layers, but retains mode and scope gates',
    async (scope) => {
      const fixture = bundle([
        entry('base', { scopes: [scope], owners: [{ majorMode: 'coding', layer: 'default' }], required: true }),
        entry('foreign', { scopes: [scope], owners: [{ majorMode: 'review', layer: 'default' }], required: true }),
        entry('wrong-scope', {
          scopes: [scope === 'session' ? 'hub' : 'session'],
          owners: [{ majorMode: 'coding', layer: 'default' }],
          required: true,
        }),
        entry('disabled', { scopes: [scope], required: true }),
      ]);
      fs.writeFileSync(path.join(fixture.directory, 'base.mjs'), 'export default { apply() {} };');
      const loaded = await loadServerBundle(scope, { ...fixture.options, activeLayers: [] });
      expect(loaded.facets.map(({ declaration }) => declaration.packageName)).toEqual(['base']);
    },
  );

  it('loads eligible packages in descriptor order and retains their attribution', async () => {
    const fixture = bundle([entry('second'), entry('first')]);
    for (const name of ['second', 'first']) {
      fs.writeFileSync(path.join(fixture.directory, `${name}.mjs`), 'export default { apply() {} };');
    }
    const loaded = await loadServerBundle('session', fixture.options);
    expect(loaded.descriptor).toEqual(fixture.descriptor);
    expect(loaded.facets.map(({ declaration }) => declaration.packageName)).toEqual(['second', 'first']);
  });

  it('accepts an empty composition', async () => {
    const fixture = bundle([]);
    expect((await loadServerBundle('hub', fixture.options)).facets).toEqual([]);
  });

  it('filters scope, mode and layer before importing even required candidates', async () => {
    const fixture = bundle([
      entry('hub', { scopes: ['hub'], required: true }),
      entry('mode', { owners: [{ majorMode: 'review', layer: 'tools' }], required: true }),
      entry('layer', { owners: [{ majorMode: 'coding', layer: 'disabled' }], required: true }),
    ]);
    // Missing modules would fail readiness if the loader imported a disabled candidate.
    expect((await loadServerBundle('session', fixture.options)).facets).toEqual([]);
  });

  it('accepts any matching ownership occurrence without duplicating a package', async () => {
    const fixture = bundle([
      entry('shared', {
        owners: [
          { majorMode: 'review', layer: 'tools' },
          { majorMode: 'coding', layer: 'tools' },
        ],
      }),
    ]);
    fs.writeFileSync(path.join(fixture.directory, 'shared.mjs'), 'export default { apply() {} };');
    expect((await loadServerBundle('session', fixture.options)).facets).toHaveLength(1);
  });

  it.each([
    ['missing', undefined],
    ['throwing', 'throw new Error("import refused");'],
    ['invalid', 'export default () => undefined;'],
  ])('isolates an optional %s module and keeps the healthy package', async (name, source) => {
    const fixture = bundle([entry(name), entry('healthy')]);
    if (source !== undefined) fs.writeFileSync(path.join(fixture.directory, `${name}.mjs`), source);
    fs.writeFileSync(path.join(fixture.directory, 'healthy.mjs'), 'export default { apply() {} };');
    const notices: string[] = [];
    const loaded = await loadServerBundle('session', {
      ...fixture.options,
      onNotice: (notice) => notices.push(notice),
    });
    expect(loaded.facets.map(({ declaration }) => declaration.packageName)).toEqual(['healthy']);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`'${name}'`);
  });

  it('refuses readiness when a required module cannot load', async () => {
    const fixture = bundle([entry('required', { required: true })]);
    await expect(loadServerBundle('session', fixture.options)).rejects.toThrow("'required'");
  });

  it.each(['generation', 'fingerprint'] as const)('rejects an unexpected %s before imports', async (field) => {
    const fixture = bundle([entry('required', { required: true })]);
    await expect(loadServerBundle('session', { ...fixture.options, [field]: 'wrong' })).rejects.toThrow(
      'admitted generation',
    );
  });

  it('does not fall back to legacy modules for a corrupt selected descriptor', async () => {
    const fixture = bundle([]);
    fs.writeFileSync(fixture.descriptorFile, '{');
    fs.writeFileSync(path.join(fixture.directory, 'session.facets.mjs'), 'export const facets = [{ apply() {} }];');
    await expect(loadServerBundle('session', fixture.options)).rejects.toThrow();
  });

  it('rejects a descriptor symlink outside its admitted directory', async () => {
    const fixture = bundle([]);
    const outside = path.join(temporaryDirectory(), DOOM_SERVER_BUNDLE_FILE);
    fs.renameSync(fixture.descriptorFile, outside);
    fs.symlinkSync(outside, fixture.descriptorFile);
    await expect(loadServerBundle('session', fixture.options)).rejects.toThrow('escapes its generation');
  });

  it('never executes a module symlink outside its generation', async () => {
    const fixture = bundle([entry('outside', { required: true })]);
    const outside = path.join(temporaryDirectory(), 'outside.mjs');
    fs.writeFileSync(outside, 'throw new Error("must not execute");');
    fs.symlinkSync(outside, path.join(fixture.directory, 'outside.mjs'));
    await expect(loadServerBundle('session', fixture.options)).rejects.toThrow('escapes its generation');
  });

  it.each([
    '../outside.mjs',
    './a/../outside.mjs',
    './%2e%2e/outside.mjs',
    './a\\outside.mjs',
    '/outside.mjs',
    './a.mjs?x',
    './a//b.mjs',
  ])('rejects unsafe module reference %s', (module) => {
    const fixture = bundle([entry('unsafe', { module })]);
    expect(() => parseDoomServerBundle(fixture.descriptor)).toThrow('contained ./file');
  });

  it('validates every candidate before importing any package', async () => {
    const fixture = bundle([entry('required', { required: true }), entry('duplicate'), entry('duplicate')]);
    await expect(loadServerBundle('session', fixture.options)).rejects.toThrow('Duplicate server bundle package');
  });

  it.each([
    { version: 2 },
    { fingerprint: 'bad' },
    { entries: null },
    { entries: [entry('invalid', { scopes: [] })] },
    { entries: [entry('invalid', { scopes: ['hub', 'hub'] })] },
    { entries: [entry('invalid', { owners: [] })] },
    { entries: [entry('invalid', { owners: [{ majorMode: 'coding', layer: '' }] })] },
    {
      entries: [
        entry('invalid', {
          owners: [
            { majorMode: 'coding', layer: 'tools' },
            { majorMode: 'coding', layer: 'tools' },
          ],
        }),
      ],
    },
    { entries: [{ ...entry('invalid'), required: undefined }] },
  ])('rejects invalid descriptor metadata %j', (overrides) => {
    const fixture = bundle([]);
    expect(() => parseDoomServerBundle({ ...fixture.descriptor, ...overrides })).toThrow();
  });
});
