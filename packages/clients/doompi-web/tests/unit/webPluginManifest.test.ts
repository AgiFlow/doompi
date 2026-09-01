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

const declare = (overrides: Record<string, unknown>, dir = '/a'): ReturnType<typeof declaredPluginsOf> =>
  declaredPluginsOf(dir, { doompiWeb: block(overrides) }, false);

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

  it('defaults registrationOrder to 1000 and ignores keys it does not know', () => {
    const [plugin] = declaredPluginsOf(
      '/pkg',
      { doompiWeb: { pluginId: 'demo', client: './web/index.ts', dependencies: ['ghost'], extra: true } },
      false,
    );
    expect(plugin?.registrationOrder).toBe(1000);
    expect(plugin).not.toHaveProperty('dependencies');
  });

  it('orders by registrationOrder then pluginId and allows ties', () => {
    const ordered = orderDeclaredPlugins([
      ...declare({ pluginId: 'zeta', registrationOrder: 5 }, '/z'),
      ...declare({ pluginId: 'alpha', registrationOrder: 5 }, '/a'),
      ...declare({ pluginId: 'late' }, '/l'),
      ...declare({ pluginId: 'first', registrationOrder: 1 }, '/f'),
      ...declaredPluginsOf('/d', { doompiWeb: { pluginId: 'defaulted', client: './web/index.ts' } }, false),
    ]);
    expect(ordered.map((plugin) => plugin.pluginId)).toEqual(['first', 'late', 'alpha', 'zeta', 'defaulted']);
  });

  it('keeps the first of a duplicate pluginId and notices the loser', () => {
    const notices: string[] = [];
    const ordered = orderDeclaredPlugins(
      [...declare({ registrationOrder: 2 }, '/second'), ...declare({ registrationOrder: 1 }, '/first')],
      (message) => notices.push(message),
    );
    expect(ordered.map((plugin) => plugin.packageDir)).toEqual(['/first']);
    expect(notices).toEqual(["web plugin 'demo' from /second is skipped: /first already declares it."]);
  });

  it('notices a channel two packages both declare and keeps both plugins', () => {
    const notices: string[] = [];
    const ordered = orderDeclaredPlugins(
      [
        ...declare({ channels: ['shared'] }),
        ...declare({ pluginId: 'two', registrationOrder: 2, channels: ['shared', 'own'] }, '/b'),
      ],
      (message) => notices.push(message),
    );
    expect(ordered.map((plugin) => plugin.pluginId)).toEqual(['demo', 'two']);
    expect(notices).toEqual(["web plugin 'two' channel 'shared' is already claimed by 'demo'; the first keeps it."]);
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

  it('accepts an external package that ships its built hub entry without its hub source', () => {
    const host = pluginPackage({ name: 'host' });
    const plugin = pluginPackage(
      {
        name: 'published',
        doompiWeb: block({ hub: { entry: './src/hub.ts', dist: './dist/hub.mjs' } }),
      },
      ['web/index.ts', 'dist/hub.mjs'],
    );

    expect(scanWebPlugins(host, [plugin]).map(({ pluginId }) => pluginId)).toEqual(['demo']);
  });

  it('skips a plugin root with a missing entry, a malformed block, or an unreadable manifest, with a notice', () => {
    const host = pluginPackage({ name: 'host' });
    const fine = pluginPackage({ name: 'fine', doompiWeb: block({ pluginId: 'fine' }) });
    const missingClient = pluginPackage({ name: 'p', doompiWeb: block() }, []);
    const missingHub = pluginPackage(
      {
        name: 'p',
        doompiWeb: block({ pluginId: 'hubless', hub: { entry: './src/hub.ts', dist: './dist/hub.mjs' } }),
      },
      ['web/index.ts', 'src/hub.ts'],
    );
    const malformed = pluginPackage({ name: 'p', doompiWeb: block({ pluginId: 'Bad Case' }) });
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-broken-'));
    cleanups.push(() => fs.rmSync(broken, { recursive: true, force: true }));
    fs.writeFileSync(path.join(broken, 'package.json'), 'not json');

    const notices: string[] = [];
    const plugins = scanWebPlugins(host, [missingClient, fine, missingHub, malformed, broken], (message) =>
      notices.push(message),
    );
    expect(plugins.map((p) => p.pluginId)).toEqual(['fine']);
    expect(notices).toHaveLength(4);
    expect(notices[0]).toMatch(/skipped: .*client\.entry '\.\/web\/index\.ts' does not exist/);
    expect(notices[1]).toMatch(/skipped: .*hub\.dist '\.\/dist\/hub\.mjs' does not exist/);
    expect(notices[2]).toMatch(/skipped: .*kebab-case/);
    expect(notices[3]).toMatch(/skipped: .*package\.json is unreadable/);
  });

  it("still throws on the host package's own manifest", () => {
    const host = pluginPackage({ name: 'host', doompiWeb: block({ pluginId: 'Bad Case' }) });
    expect(() => scanWebPlugins(host, [])).toThrow(/kebab-case/);
    const hostMissingEntry = pluginPackage({ name: 'host', doompiWeb: block() }, []);
    expect(() => scanWebPlugins(hostMissingEntry, [])).toThrow(/client\.entry/);
  });
});
