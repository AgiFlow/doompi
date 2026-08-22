import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMajorModesConfig, type MajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { describe, expect, it } from 'vitest';
import {
  assembleChildExtensions,
  assembleExtensions,
  type ExtensionContext,
  type ExtensionLayerResolvers,
  resolveExtensionComposition,
} from '../../src/services/extensionAssembler.ts';

const CONFIG_PATH = '/repo/.doom/modes.yaml';
const REPOSITORY_ROOT = path.resolve(__dirname, '..', 'fixtures', 'repository');
const CONFIGURED_COPILOT_FEATURE_PACKAGES = [
  '@agimon-ai/doompi-team',
  '@agimon-ai/doompi-user-feedback',
  '@agimon-ai/doompi-task',
  '@agimon-ai/vibe-lint',
] as const;
const CONFIGURED_DEFAULT_PACKAGES = [
  '@agimon-ai/doompi-help',
  '@agimon-ai/doompi-hook',
  '@agimon-ai/doompi-goal',
  '@agimon-ai/doompi-voice',
  '@agimon-ai/doompi-runner',
  '@agimon-ai/doompi-read',
  '@agimon-ai/doompi-grep',
  '@agimon-ai/doompi-edit',
  '@agimon-ai/doompi-file-edit',
  '@agimon-ai/doompi-autocompact',
  '@agimon-ai/doompi-loop',
  '@agimon-ai/doompi-plan',
  '@agimon-ai/doompi-workflow',
  '@agimon-ai/doompi-log',
  '@agimon-ai/doompi-mcp',
] as const;

function modes(
  layers: MajorModesConfig['layers'],
  selected: string[] = Object.keys(layers),
  modeSource = CONFIG_PATH,
): MajorModesConfig {
  return {
    layers,
    defaultMajorMode: 'test',
    majorMode: { test: { description: 'Test mode.', layers: selected } },
    majorModeSources: { test: { filePath: modeSource, baseDirectory: '/repo' } },
  };
}

function layer(
  definition: Omit<MajorModesConfig['layers'][string], 'baseDirectory' | 'filePath'> = {},
  baseDirectory = '/repo',
  filePath = CONFIG_PATH,
): MajorModesConfig['layers'][string] {
  return { ...definition, baseDirectory, filePath };
}

function withDefault(config: MajorModesConfig, definition: NonNullable<MajorModesConfig['default']>): MajorModesConfig {
  return { ...config, default: definition };
}

function resolver(overrides: Partial<ExtensionLayerResolvers> = {}): ExtensionLayerResolvers {
  return {
    ownEntry: (name) => `/own/${name}.ts`,
    packageEntry: (name) => `/package/${name}.mjs`,
    optionalPackageEntry: () => undefined,
    packageEntries: (name) => [`/manifest/${name}/pi.mjs`],
    optionalPackageEntries: () => undefined,
    localEntry: () => undefined,
    localEntries: () => undefined,
    localPackageEntries: () => undefined,
    localPackageName: () => undefined,
    ...overrides,
  };
}

function context(majorModesConfig: MajorModesConfig, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    agents: true,
    autoStop: false,
    majorMode: 'test',
    layers: [...(majorModesConfig.majorMode.test?.layers ?? [])],
    majorModesConfig,
    resolvers: resolver(),
    ...overrides,
  };
}

function selectedPaths(composition: ReturnType<typeof resolveExtensionComposition>): string[] {
  return composition.selections.flatMap((selection) => (selection.path ? [selection.path] : []));
}

describe('standard extension composition', () => {
  it('resolves every fixed DoomPi host entry to an existing default factory', async () => {
    const config = modes({}, []);
    const entries = assembleExtensions({
      agents: true,
      autoStop: true,
      majorMode: 'test',
      layers: [],
      majorModesConfig: config,
    });
    const ownDirectory = path.resolve(__dirname, '..', '..', 'src', 'extensions', 'entries');
    const ownEntries = entries.filter((entry) => entry.startsWith(ownDirectory));

    expect(ownEntries.length).toBeGreaterThan(0);
    for (const entry of ownEntries) {
      expect(fs.existsSync(entry), entry).toBe(true);
      const module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
      expect(typeof module.default, entry).toBe('function');
    }
  });

  it('activates configured defaults before the checked-in copilot feature set', () => {
    const config = loadMajorModesConfig(REPOSITORY_ROOT);
    const layers = resolveLayers(config, config.defaultMajorMode);
    const composition = resolveExtensionComposition(
      context(config, {
        majorMode: config.defaultMajorMode,
        layers,
        resolvers: resolver(),
      }),
    );
    const defaultSelections = composition.selections.filter(({ layer: name }) => name === 'default');
    const featureSelections = composition.selections.filter(
      ({ entryKind, layer: name }) => entryKind === 'package' && name !== 'default',
    );

    expect(defaultSelections.map(({ selector }) => selector)).toEqual(CONFIGURED_DEFAULT_PACKAGES);
    expect(defaultSelections.every(({ layerIndex }) => layerIndex === -1)).toBe(true);
    expect(featureSelections.map(({ selector }) => selector)).toEqual(CONFIGURED_COPILOT_FEATURE_PACKAGES);
    expect(composition.selections.every(({ outcome }) => outcome === 'resolved')).toBe(true);
    expect(composition.parentActivation.filter((entry) => entry.startsWith('/manifest/'))).toEqual(
      [...CONFIGURED_DEFAULT_PACKAGES, ...CONFIGURED_COPILOT_FEATURE_PACKAGES].map(
        (name) => `/manifest/${name}/pi.mjs`,
      ),
    );
    expect(composition.childActivation.filter((entry) => entry.startsWith('/manifest/'))).toEqual(
      [...CONFIGURED_DEFAULT_PACKAGES, ...CONFIGURED_COPILOT_FEATURE_PACKAGES].map(
        (name) => `/manifest/${name}/pi.mjs`,
      ),
    );
  });

  it('does not activate a package fallback when default is absent', () => {
    const composition = resolveExtensionComposition(context(modes({}, [])));

    expect(composition.selections).toEqual([]);
    expect(composition.parentActivation.filter((entry) => entry.startsWith('/manifest/'))).toEqual([]);
    expect(composition.childActivation.filter((entry) => entry.startsWith('/manifest/'))).toEqual([]);
  });

  it('returns actual factory activation order with fixed providers first', () => {
    const config = modes({ feature: layer({ packages: ['feature-package'] }) });
    const entries = assembleExtensions(context(config));

    expect(entries.slice(0, 5)).toEqual([
      '/own/cordisHost.ts',
      '/own/modeCatalog.ts',
      '/package/@agimon-ai/doompi-config/extensions/pi.mjs',
      '/own/transitionCoordinator.ts',
      '/package/@agimon-ai/doompi-ui/extensions/pi.mjs',
    ]);
    expect(entries).toContain('/package/@agimon-ai/doompi-domain/extensions/pi.mjs');
    expect(entries.indexOf('/manifest/feature-package/pi.mjs')).toBeGreaterThan(entries.indexOf('/own/effort.ts'));
  });

  it('preserves authored layer, entry, and manifest order', () => {
    const config = modes({
      first: layer({ extensions: ['first-own'], packages: ['multi'] }),
      second: layer({ packages: ['last'] }),
    });
    const composition = resolveExtensionComposition(
      context(config, {
        resolvers: resolver({
          packageEntries: (name) =>
            name === 'multi' ? ['/manifest/multi/a.mjs', '/manifest/multi/b.mjs'] : [`/manifest/${name}/pi.mjs`],
        }),
      }),
    );

    expect(selectedPaths(composition)).toEqual([
      '/own/first-own.ts',
      '/manifest/multi/a.mjs',
      '/manifest/multi/b.mjs',
      '/manifest/last/pi.mjs',
    ]);
    expect(
      composition.selections.map(({ layer: name, layerIndex, entryIndex, manifestIndex }) => ({
        name,
        layerIndex,
        entryIndex,
        manifestIndex,
      })),
    ).toEqual([
      { name: 'first', layerIndex: 0, entryIndex: 0, manifestIndex: 0 },
      { name: 'first', layerIndex: 0, entryIndex: 1, manifestIndex: 0 },
      { name: 'first', layerIndex: 0, entryIndex: 1, manifestIndex: 1 },
      { name: 'second', layerIndex: 1, entryIndex: 0, manifestIndex: 0 },
    ]);
  });

  it('retains repeated authored occurrences while deduplicating activation by canonical path', () => {
    const config = modes({ repeated: layer({ packages: ['same'] }) }, ['repeated', 'repeated']);
    const composition = resolveExtensionComposition(context(config));

    expect(composition.layers.map(({ name }) => name)).toEqual(['repeated', 'repeated']);
    expect(composition.selections).toHaveLength(2);
    expect(composition.selections.map(({ layerIndex }) => layerIndex)).toEqual([0, 1]);
    expect(composition.parentActivation.filter((entry) => entry === '/manifest/same/pi.mjs')).toHaveLength(1);
    expect(composition.childActivation.filter((entry) => entry === '/manifest/same/pi.mjs')).toHaveLength(1);
  });

  it('deduplicates path aliases without collapsing different package identities', () => {
    const config = modes({
      aliases: layer({ packages: ['first', 'second'] }),
    });
    const composition = resolveExtensionComposition(
      context(config, {
        resolvers: resolver({
          packageEntries: (name) => (name === 'first' ? ['/resolved/pkg/../pkg/pi.mjs'] : ['/resolved/pkg/pi.mjs']),
        }),
      }),
    );

    expect(composition.selections).toHaveLength(2);
    expect(composition.parentActivation.filter((entry) => entry.includes('/resolved/pkg'))).toHaveLength(1);
  });

  it('retains default and named-layer provenance with opaque package config', () => {
    const config = withDefault(
      modes({
        feature: layer(
          { packages: [{ name: 'feature-configured', config: { source: 'feature' } }] },
          '/repository',
          '/repository/.doom/modes.yaml',
        ),
      }),
      layer(
        {
          packages: [
            {
              name: 'default-configured',
              config: { z: 1, nested: { disabled: null }, list: [null, { value: true }] },
            },
          ],
        },
        '/global/.doom',
        '/global/.doom/modes.yaml',
      ),
    );
    const composition = resolveExtensionComposition(context(config));

    expect(composition.layers).toEqual([
      { name: 'feature', index: 0, sourceFile: '/repository/.doom/modes.yaml', baseDirectory: '/repository' },
    ]);
    expect(composition.selections[0]).toMatchObject({
      layer: 'default',
      layerIndex: -1,
      selector: 'default-configured',
      sourceFile: '/global/.doom/modes.yaml',
      baseDirectory: '/global/.doom',
      config: { z: 1, nested: { disabled: null }, list: [null, { value: true }] },
    });
    expect(composition.selections[1]).toMatchObject({
      layer: 'feature',
      layerIndex: 0,
      selector: 'feature-configured',
      sourceFile: '/repository/.doom/modes.yaml',
      baseDirectory: '/repository',
      config: { source: 'feature' },
    });
  });

  it('records missing optional packages instead of silently dropping them', () => {
    const config = modes({
      optional: layer({ packages: [{ name: 'absent', optional: true, config: { reason: null } }] }),
    });
    const composition = resolveExtensionComposition(context(config));

    expect(composition.selections).toEqual([
      expect.objectContaining({
        selector: 'absent',
        optional: true,
        outcome: 'missing-optional',
        diagnostic: expect.stringContaining('unavailable'),
        config: { reason: null },
      }),
    ]);
    expect(composition.parentActivation.some((entry) => entry.includes('absent'))).toBe(false);
  });

  it('turns optional resolver failures into retained diagnostics', () => {
    const config = modes({ optional: layer({ packages: [{ name: 'broken', optional: true }] }) });
    const composition = resolveExtensionComposition(
      context(config, {
        resolvers: resolver({
          optionalPackageEntries: () => {
            throw new Error('invalid package manifest');
          },
        }),
      }),
    );

    expect(composition.selections[0]).toMatchObject({
      outcome: 'missing-optional',
      diagnostic: 'invalid package manifest',
    });
  });

  it('fails required packages that resolve no standard Pi extensions', () => {
    const config = modes({ required: layer({ packages: ['missing-manifest'] }) });

    expect(() =>
      resolveExtensionComposition(
        context(config, {
          resolvers: resolver({
            packageEntries: (name) => (name === 'missing-manifest' ? [] : [`/manifest/${name}/pi.mjs`]),
          }),
        }),
      ),
    ).toThrow('declares no Pi extensions');
  });

  it('fails when a required configured default declares no Pi extensions', () => {
    const config = withDefault(modes({}, []), layer({ packages: ['required-default'] }));

    expect(() =>
      resolveExtensionComposition(
        context(config, {
          resolvers: resolver({
            packageEntries: (name) => (name === 'required-default' ? [] : [`/manifest/${name}/pi.mjs`]),
          }),
        }),
      ),
    ).toThrow('Layer "default" package "required-default" declares no Pi extensions');
  });

  it('preserves explicit package subpaths and standard manifest results without curated adapters', () => {
    const config = modes({
      feature: layer({ packages: ['@agimon-ai/doompi-plan', '@scope/tool/extensions/custom'] }),
    });
    const composition = resolveExtensionComposition(
      context(config, {
        resolvers: resolver({
          packageEntries: (name) =>
            name === '@agimon-ai/doompi-plan' ? ['/manifest/doompi-plan/extensions/pi.mjs'] : ['/exports/custom.mjs'],
        }),
      }),
    );

    expect(selectedPaths(composition)).toEqual(['/manifest/doompi-plan/extensions/pi.mjs', '/exports/custom.mjs']);
    expect(selectedPaths(composition).some((entry) => entry.includes('/extensions/doom'))).toBe(false);
  });

  it.each([
    '@agimon-ai/doompi',
    '@agimon-ai/doompi/extensions/pi',
    '@agimon-ai/doompi-cache',
    '@agimon-ai/doompi-cache/extensions/pi',
    '@agimon-ai/doompi-config',
    '@agimon-ai/doompi-config/extensions/pi',
    '@agimon-ai/doompi-domain',
    '@agimon-ai/doompi-domain/extensions/pi',
    '@agimon-ai/doompi-ui',
  ])('rejects fixed core package selection from named layers and default: %s', (packageName) => {
    const namedLayerConfig = modes({ invalid: layer({ packages: [packageName] }) });
    const defaultConfig = withDefault(modes({}, []), layer({ packages: [packageName] }));

    expect(() => resolveExtensionComposition(context(namedLayerConfig))).toThrow(
      'cannot select fixed DoomPi host package',
    );
    expect(() => resolveExtensionComposition(context(defaultConfig))).toThrow(
      `Layer "default" cannot select fixed DoomPi host package "${packageName.split('/extensions/')[0]}"`,
    );
  });

  it('rejects a local package whose manifest identity duplicates fixed core', () => {
    const config = modes({ invalid: layer({ packages: ['./local-config'] }) });

    expect(() =>
      resolveExtensionComposition(
        context(config, {
          resolvers: resolver({
            localPackageName: () => '@agimon-ai/doompi-config',
            localPackageEntries: () => ['/repo/local-config/pi.mjs'],
          }),
        }),
      ),
    ).toThrow('cannot select fixed DoomPi host package');
  });

  it('keeps two local packages with the same non-core manifest name when their paths differ', () => {
    const config = modes({
      first: layer({ packages: ['./v1'] }),
      second: layer({ packages: ['./v2'] }),
    });
    const composition = resolveExtensionComposition(
      context(config, {
        resolvers: resolver({
          localPackageName: () => '@repository/shared',
          localPackageEntries: (specifier) => [`/repo/${specifier.slice(2)}/pi.mjs`],
        }),
      }),
    );

    expect(selectedPaths(composition)).toEqual(['/repo/v1/pi.mjs', '/repo/v2/pi.mjs']);
    expect(composition.parentActivation).toEqual(expect.arrayContaining(['/repo/v1/pi.mjs', '/repo/v2/pi.mjs']));
  });

  it('reports missing required local extensions and packages with declaring roots', () => {
    const extensionConfig = modes({ broken: layer({ extensions: ['./missing.ts'] }, '/declaring/root') });
    expect(() => resolveExtensionComposition(context(extensionConfig))).toThrow(
      'extension "./missing.ts" does not resolve under /declaring/root',
    );

    const packageConfig = modes({ broken: layer({ packages: ['./missing'] }, '/declaring/root') });
    expect(() => resolveExtensionComposition(context(packageConfig))).toThrow(
      'package "./missing" does not resolve under /declaring/root',
    );
  });

  it('passes local extension and package paths through the declaring base directory', () => {
    const config = modes({
      local: layer({ extensions: ['./extension.ts'], packages: ['./package'] }, '/declaring/root'),
    });
    const seen: Array<[string, string, string]> = [];
    resolveExtensionComposition(
      context(config, {
        resolvers: resolver({
          localEntries: (specifier, baseDirectory) => {
            seen.push(['extension', specifier, baseDirectory]);
            return ['/declaring/root/extension.ts'];
          },
          localPackageEntries: (specifier, baseDirectory) => {
            seen.push(['package', specifier, baseDirectory]);
            return ['/declaring/root/package/pi.mjs'];
          },
        }),
      }),
    );

    expect(seen).toEqual([
      ['extension', './extension.ts', '/declaring/root'],
      ['package', './package', '/declaring/root'],
    ]);
  });

  it('gives parents and children the same selected feature stream in the same order', () => {
    const config = modes({
      features: layer({ packages: ['one', 'two'] }),
    });
    const composition = resolveExtensionComposition(context(config, { agents: false }));
    const featurePaths = ['/manifest/one/pi.mjs', '/manifest/two/pi.mjs'];

    expect(composition.parentActivation.filter((entry) => featurePaths.includes(entry))).toEqual(featurePaths);
    expect(composition.childActivation.filter((entry) => featurePaths.includes(entry))).toEqual(featurePaths);
    expect(composition.childActivation[0]).toBe('/own/cordisHost.ts');
    expect(composition.childActivation[1]).toBe('/package/@agimon-ai/doompi-config/extensions/pi.mjs');
    expect(composition.childActivation.at(-1)).toBe('/own/cordisFinalizer.ts');
    expect(composition.childActivation).not.toContain('/package/@agimon-ai/doompi-ui/extensions/pi.mjs');
    expect(composition.childActivation).not.toContain('/own/transitionCoordinator.ts');
  });

  it('does not centrally filter feature packages by parent, child, agents, or UI assumptions', () => {
    const config = modes({ features: layer({ packages: ['team', 'review', 'custom'] }) });
    const enabled = resolveExtensionComposition(context(config, { agents: true }));
    const disabled = resolveExtensionComposition(context(config, { agents: false }));

    expect(selectedPaths(enabled)).toEqual(selectedPaths(disabled));
    expect(
      enabled.childActivation.filter((entry) =>
        ['/manifest/team/pi.mjs', '/manifest/review/pi.mjs', '/manifest/custom/pi.mjs'].includes(entry),
      ),
    ).toEqual(['/manifest/team/pi.mjs', '/manifest/review/pi.mjs', '/manifest/custom/pi.mjs']);
  });

  it('keeps repeated declarations visible while deduplicating configured-default activation', () => {
    const repeatedPackages = ['@agimon-ai/doompi-workflow', '@agimon-ai/doompi-mcp'];
    const config = withDefault(
      modes({
        workflow: layer({ packages: ['@agimon-ai/doompi-workflow'] }),
        mcp: layer({ packages: ['@agimon-ai/doompi-mcp'] }),
      }),
      layer({ packages: repeatedPackages }),
    );
    const composition = resolveExtensionComposition(
      context(config, { personaEntry: '/context/persona.mjs', autoStop: true }),
    );

    expect(
      composition.selections.map(({ layer: name, layerIndex, selector }) => ({ name, layerIndex, selector })),
    ).toEqual([
      { name: 'default', layerIndex: -1, selector: '@agimon-ai/doompi-workflow' },
      { name: 'default', layerIndex: -1, selector: '@agimon-ai/doompi-mcp' },
      { name: 'workflow', layerIndex: 0, selector: '@agimon-ai/doompi-workflow' },
      { name: 'mcp', layerIndex: 1, selector: '@agimon-ai/doompi-mcp' },
    ]);
    const expectedDefaults = repeatedPackages.map((name) => `/manifest/${name}/pi.mjs`);
    expect(composition.parentActivation.filter((entry) => entry.startsWith('/manifest/'))).toEqual(expectedDefaults);
    expect(composition.childActivation.filter((entry) => entry.startsWith('/manifest/'))).toEqual(expectedDefaults);
    expect(composition.parentActivation.slice(-4)).toEqual([
      '/context/persona.mjs',
      '/package/@agimon-ai/doompi-autostop/extensions/pi.mjs',
      '/package/@agimon-ai/doompi-cache/extensions/pi.mjs',
      '/own/cordisFinalizer.ts',
    ]);
    expect(composition.childActivation.slice(-2)).toEqual(['/context/persona.mjs', '/own/cordisFinalizer.ts']);
    expect(composition.childActivation).not.toContain('/package/@agimon-ai/doompi-cache/extensions/pi.mjs');
  });

  it('applies mute and preset only to fixed host entries', () => {
    const config = modes({ feature: layer({ packages: ['feature'] }) });
    const normal = assembleExtensions(context(config));
    const altered = assembleExtensions(context(config, { mute: true, preset: 'ollama' }));

    expect(normal).toContain('/package/@agimon-ai/doompi-notification/extensions/pi.mjs');
    expect(normal).not.toContain('/own/ollamaProvider.ts');
    expect(altered).not.toContain('/package/@agimon-ai/doompi-notification/extensions/pi.mjs');
    expect(altered).toContain('/own/ollamaProvider.ts');
    expect(altered).toContain('/manifest/feature/pi.mjs');
  });

  it('deduplicates selected and fixed paths by canonical identity', () => {
    const config = modes({ duplicate: layer({ packages: ['duplicate'] }) });
    const composition = resolveExtensionComposition(
      context(config, {
        personaEntry: '/context/../context/duplicate.mjs',
        resolvers: resolver({ packageEntries: () => ['/context/duplicate.mjs'] }),
      }),
    );

    expect(composition.parentActivation.filter((entry) => entry.includes('duplicate.mjs'))).toHaveLength(1);
    expect(composition.childActivation.filter((entry) => entry.includes('duplicate.mjs'))).toHaveLength(1);
  });

  it('keeps fingerprints stable across opaque object key order', () => {
    const first = modes({
      configured: layer({ packages: [{ name: 'feature', config: { b: 2, a: { y: null, x: 1 } } }] }),
    });
    const second = modes({
      configured: layer({ packages: [{ name: 'feature', config: { a: { x: 1, y: null }, b: 2 } }] }),
    });

    expect(resolveExtensionComposition(context(first)).fingerprint).toBe(
      resolveExtensionComposition(context(second)).fingerprint,
    );
  });

  it.each([
    [
      'layer order',
      (config: MajorModesConfig) => ({
        ...config,
        majorMode: { test: { description: 'Test mode.', layers: ['two', 'one'] } },
      }),
    ],
    [
      'mode provenance',
      (config: MajorModesConfig) => ({
        ...config,
        majorModeSources: { test: { filePath: '/other/modes.yaml', baseDirectory: '/other' } },
      }),
    ],
    [
      'layer provenance',
      (config: MajorModesConfig) => ({
        ...config,
        layers: { ...config.layers, one: { ...config.layers.one!, filePath: '/other/modes.yaml' } },
      }),
    ],
    ['resolved path', (config: MajorModesConfig) => config],
    [
      'opaque config',
      (config: MajorModesConfig) => ({
        ...config,
        layers: { ...config.layers, one: layer({ packages: [{ name: 'one', config: { changed: true } }] }) },
      }),
    ],
  ])('changes the fingerprint when %s changes', (_label, mutate) => {
    const original = modes({
      one: layer({ packages: [{ name: 'one', config: { changed: false } }] }),
      two: layer({ packages: ['two'] }),
    });
    const changed = mutate(original);
    const baseFingerprint = resolveExtensionComposition(context(original)).fingerprint;
    const changedContext =
      _label === 'resolved path'
        ? context(changed, { resolvers: resolver({ packageEntries: (name) => [`/different/${name}.mjs`] }) })
        : context(changed);

    expect(resolveExtensionComposition(changedContext).fingerprint).not.toBe(baseFingerprint);
  });

  it('changes the fingerprint when an optional package becomes available', () => {
    const config = modes({ optional: layer({ packages: [{ name: 'optional', optional: true }] }) });
    const missing = resolveExtensionComposition(context(config));
    const installed = resolveExtensionComposition(
      context(config, { resolvers: resolver({ optionalPackageEntries: () => ['/installed/optional.mjs'] }) }),
    );

    expect(installed.fingerprint).not.toBe(missing.fingerprint);
  });

  it('changes the fingerprint when selected features or fixed activation context changes', () => {
    const config = modes({}, []);
    const selectedConfig = modes({ workflow: layer({ packages: ['@agimon-ai/doompi-workflow'] }) });
    const base = resolveExtensionComposition(context(config));
    const featureChanged = resolveExtensionComposition(context(selectedConfig));
    const contextChanged = resolveExtensionComposition(context(config, { personaEntry: '/context/persona.mjs' }));

    expect(featureChanged.fingerprint).not.toBe(base.fingerprint);
    expect(contextChanged.fingerprint).not.toBe(base.fingerprint);
  });

  it('returns copies from compatibility assembly views', () => {
    const config = modes({ feature: layer({ packages: ['feature'] }) });
    const composition = resolveExtensionComposition(context(config));
    const parent = assembleExtensions(context(config));
    const child = assembleChildExtensions(context(config));

    expect(parent).toEqual(composition.parentActivation);
    expect(child).toEqual(composition.childActivation);
    expect(parent).not.toBe(composition.parentActivation);
    expect(child).not.toBe(composition.childActivation);
  });
});
