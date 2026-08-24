import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanWebPlugins } from '../../src/adapters/webPluginScan.ts';
import { declaredPluginsOf, orderDeclaredPlugins, pluginBlocksOf } from '../../src/services/webPluginManifest.ts';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function pluginPackage(manifest: Record<string, unknown>, entries: string[] = ['web/index.ts']): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-manifest-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  for (const entry of entries) {
    const file = path.join(root, entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  return root;
}

function block(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pluginId: 'demo', registrationOrder: 1, client: './web/index.ts', ...overrides };
}

describe('the doompiWeb manifest vocabulary', () => {
  it('normalizes one block or an array of blocks', () => {
    expect(pluginBlocksOf({})).toEqual([]);
    expect(pluginBlocksOf({ doompiWeb: block() })).toHaveLength(1);
    expect(pluginBlocksOf({ doompiWeb: [block(), block({ pluginId: 'two' })] })).toHaveLength(2);
  });

  it('rejects the malformed shapes a manifest can take', () => {
    const at =
      (b: unknown): (() => unknown) =>
      () =>
        declaredPluginsOf('/pkg', { doompiWeb: b }, false);
    expect(at('junk')).toThrow(/must be an object/);
    expect(at(block({ pluginId: 'Bad Case' }))).toThrow(/kebab-case/);
    expect(at(block({ registrationOrder: -1 }))).toThrow(/non-negative integer/);
    expect(at(block({ registrationOrder: 1.5 }))).toThrow(/non-negative integer/);
    expect(at(block({ dependencies: [42] }))).toThrow(/pluginId strings/);
    expect(at(block({ channels: [''] }))).toThrow(/non-empty strings/);
    expect(at(block({ client: 'web/index.ts' }))).toThrow(/package-relative/);
    expect(at(block({ client: './../escape.ts' }))).toThrow(/package-relative/);
    expect(at(block({ client: 42 }))).toThrow(/must be a path/);
    expect(at(block({ hub: { entry: './src/hub.ts' } }))).toThrow(/hub\.dist is required/);
    expect(at(block({ hub: { entry: './src/hub.ts', dist: 'dist/hub.mjs' } }))).toThrow(
      /dist must be a package-relative/,
    );
  });

  it('lets the host omit hub.dist but requires it from externals', () => {
    const hostOnly = declaredPluginsOf('/pkg', { doompiWeb: block({ hub: { entry: './src/hub.ts' } }) }, true);
    expect(hostOnly[0]?.hub).toEqual({ entry: './src/hub.ts' });
  });

  it('rejects duplicate ids, orders, channels, unknown deps, and cycles across packages', () => {
    const declare = (overrides: Record<string, unknown>, dir = '/a'): ReturnType<typeof declaredPluginsOf> =>
      declaredPluginsOf(dir, { doompiWeb: block(overrides) }, false);
    expect(() => orderDeclaredPlugins([...declare({}), ...declare({}, '/b')])).toThrow(/duplicate pluginId/);
    expect(() =>
      orderDeclaredPlugins([...declare({}), ...declare({ pluginId: 'two', registrationOrder: 1 }, '/b')]),
    ).toThrow(/registrationOrder 1 is already used/);
    expect(() =>
      orderDeclaredPlugins([
        ...declare({ channels: ['shared'] }),
        ...declare({ pluginId: 'two', registrationOrder: 2, channels: ['shared'] }, '/b'),
      ]),
    ).toThrow(/already claimed/);
    expect(() => orderDeclaredPlugins(declare({ dependencies: ['ghost'] }))).toThrow(/unknown plugin 'ghost'/);
    expect(() =>
      orderDeclaredPlugins([
        ...declare({ dependencies: ['two'] }),
        ...declare({ pluginId: 'two', registrationOrder: 2, dependencies: ['demo'] }, '/b'),
      ]),
    ).toThrow(/dependency cycle/);
  });

  it('orders dependencies first with registrationOrder as the tiebreak', () => {
    const late = declaredPluginsOf(
      '/a',
      { doompiWeb: block({ pluginId: 'late', registrationOrder: 5, dependencies: ['early'] }) },
      false,
    );
    const early = declaredPluginsOf('/b', { doompiWeb: block({ pluginId: 'early', registrationOrder: 9 }) }, false);
    const first = declaredPluginsOf('/c', { doompiWeb: block({ pluginId: 'first', registrationOrder: 1 }) }, false);
    expect(orderDeclaredPlugins([...late, ...early, ...first]).map((p) => p.pluginId)).toEqual([
      'first',
      'early',
      'late',
    ]);
  });
});

describe('the manifest scanner', () => {
  it('reads explicit roots, deduplicates them, and validates entry files exist', () => {
    const host = pluginPackage({ name: 'host' });
    const plugin = pluginPackage({ name: 'p', doompiWeb: block() });
    const plugins = scanWebPlugins(host, [plugin, plugin]);
    expect(plugins.map((p) => p.pluginId)).toEqual(['demo']);
    expect(plugins[0]?.isHost).toBe(false);
  });

  it('rejects a missing client entry, hub entry, or unreadable manifest', () => {
    const host = pluginPackage({ name: 'host' });
    const missingClient = pluginPackage({ name: 'p', doompiWeb: block() }, []);
    expect(() => scanWebPlugins(host, [missingClient])).toThrow(/client\.entry '\.\/web\/index\.ts' does not exist/);

    const missingHub = pluginPackage({
      name: 'p',
      doompiWeb: block({ hub: { entry: './src/hub.ts', dist: './dist/hub.mjs' } }),
    });
    expect(() => scanWebPlugins(host, [missingHub])).toThrow(/hub\.entry '\.\/src\/hub\.ts' does not exist/);

    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-broken-'));
    cleanups.push(() => fs.rmSync(broken, { recursive: true, force: true }));
    fs.writeFileSync(path.join(broken, 'package.json'), 'not json');
    expect(() => scanWebPlugins(host, [broken])).toThrow(/package\.json is unreadable/);
  });
});
