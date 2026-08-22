import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  filterHookDisabledLayers,
  layerEntries,
  layerHookGroups,
  loadMajorModesConfig,
  type MajorModesConfig,
  resolveLayers,
  resolvePackageConfigurations,
} from '../src/exports/majorModes.ts';

describe('major mode configuration', () => {
  let root: string;
  /** Isolated home, so a developer's own ~/.pi/.doom never reaches these tests. */
  let home: string;
  let globalDoom: string;

  const load = (): MajorModesConfig => loadMajorModesConfig(root, home);

  function writeRepoModes(contents: string): void {
    fs.writeFileSync(path.join(root, '.doom', 'modes.yaml'), contents);
  }

  function writeGlobalModes(contents: string): void {
    fs.mkdirSync(globalDoom, { recursive: true });
    fs.writeFileSync(path.join(globalDoom, 'modes.yaml'), contents);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-major-modes-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-major-modes-home-'));
    globalDoom = path.join(home, '.pi', '.doom');
    fs.mkdirSync(path.join(root, '.doom'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('loads descriptions and resolves layers from rich major modes', () => {
    writeRepoModes(`layers:
  guardrails:
    hookGroups: [guardrails]
  plan: {}
defaultMajorMode: copilot
majorMode:
  copilot:
    description: General-purpose coding assistance.
    layers: [guardrails, plan]
`);
    const config = load();
    const resolved = resolveLayers(config, 'copilot');
    expect(config.defaultMajorMode).toBe('copilot');
    expect(config.majorMode.copilot?.description).toBe('General-purpose coding assistance.');
    expect(resolved).toEqual(['guardrails', 'plan']);
    expect(resolved).not.toBe(config.majorMode.copilot?.layers);
  });

  it('normalizes legacy layer arrays with a generated description', () => {
    writeRepoModes('layers:\n  guardrails: {}\nmajorMode:\n  copilot: [guardrails]\n');

    expect(load().majorMode.copilot).toEqual({
      description: 'Uses layers: guardrails.',
      layers: ['guardrails'],
    });
  });

  it('does not synthesize a default package bundle when no source declares one', () => {
    writeRepoModes('majorMode:\n  copilot: []\n');

    expect(load().default).toBeUndefined();
  });

  it('inherits the global default package bundle and lets the repository replace it whole', () => {
    writeGlobalModes(`default:
  packages:
    - '@scope/global'
    - name: '@agimon-ai/doompi-team'
      optional: true
      config:
        models: [global]
majorMode:
  copilot: []
`);

    const inherited = load();
    expect(inherited.default).toEqual({
      packages: [
        '@scope/global',
        {
          name: '@agimon-ai/doompi-team',
          optional: true,
          config: { models: ['global'] },
        },
      ],
      baseDirectory: globalDoom,
      filePath: path.join(globalDoom, 'modes.yaml'),
    });
    expect(resolvePackageConfigurations(inherited, [], '@agimon-ai/doompi-team')).toEqual([
      {
        layer: 'default',
        specifier: '@agimon-ai/doompi-team',
        config: { models: ['global'] },
        baseDirectory: globalDoom,
        filePath: path.join(globalDoom, 'modes.yaml'),
      },
    ]);

    writeRepoModes(`default:
  packages:
    - name: '@agimon-ai/doompi-team/extensions/pi'
      config:
        models: [repository]
`);

    const replaced = load();
    expect(replaced.default).toEqual({
      packages: [
        {
          name: '@agimon-ai/doompi-team/extensions/pi',
          config: { models: ['repository'] },
        },
      ],
      baseDirectory: root,
      filePath: path.join(root, '.doom', 'modes.yaml'),
    });
    expect(resolvePackageConfigurations(replaced, [], '@agimon-ai/doompi-team')).toEqual([
      {
        layer: 'default',
        specifier: '@agimon-ai/doompi-team/extensions/pi',
        config: { models: ['repository'] },
        baseDirectory: root,
        filePath: path.join(root, '.doom', 'modes.yaml'),
      },
    ]);
  });

  it('lets an explicit empty repository default replace inherited packages', () => {
    writeGlobalModes("default:\n  packages: ['@scope/global']\nmajorMode:\n  copilot: []\n");
    writeRepoModes('default:\n  packages: []\n');

    expect(load().default).toEqual({
      packages: [],
      baseDirectory: root,
      filePath: path.join(root, '.doom', 'modes.yaml'),
    });
  });

  it.each([
    ['a non-mapping value', 'default: []', 'must be a mapping with packages'],
    ['missing packages', 'default: {}', 'packages in .doom/modes.yaml must be an array'],
    ['extensions', 'default:\n  packages: []\n  extensions: [custom]', 'unsupported field(s): extensions'],
    ['hook groups', 'default:\n  packages: []\n  hookGroups: [custom]', 'unsupported field(s): hookGroups'],
    ['an unknown field', 'default:\n  packages: []\n  typo: true', 'unsupported field(s): typo'],
  ])('rejects a default package bundle with %s', (_name, source, message) => {
    writeRepoModes(`${source}\nmajorMode:\n  copilot: []\n`);

    expect(() => load()).toThrow(message);
  });

  it('merges home and repository modes by name with repository overrides', () => {
    writeGlobalModes(`layers:
  home:
    hookGroups: [home]
  shared:
    hookGroups: [global]
defaultMajorMode: home
majorMode:
  home:
    description: Home-only mode.
    layers: [home]
  shared:
    description: Global shared mode.
    layers: [shared]
`);
    writeRepoModes(`layers:
  repo:
    hookGroups: [repo]
  shared:
    hookGroups: [repository]
majorMode:
  repo:
    description: Repository-only mode.
    layers: [repo]
  shared:
    description: Repository shared mode.
    layers: [shared, repo]
`);

    const config = load();

    expect(config.defaultMajorMode).toBe('home');
    expect(Object.keys(config.layers)).toEqual(['home', 'shared', 'repo']);
    const globalModesPath = path.join(globalDoom, 'modes.yaml');
    const repositoryModesPath = path.join(root, '.doom', 'modes.yaml');
    expect(config.layers.home).toMatchObject({
      baseDirectory: globalDoom,
      filePath: globalModesPath,
      hookGroups: ['home'],
    });
    expect(config.layers.shared).toMatchObject({
      baseDirectory: root,
      filePath: repositoryModesPath,
      hookGroups: ['repository'],
    });
    expect(config.majorMode).toEqual({
      home: { description: 'Home-only mode.', layers: ['home'] },
      shared: { description: 'Repository shared mode.', layers: ['shared', 'repo'] },
      repo: { description: 'Repository-only mode.', layers: ['repo'] },
    });
    expect(config.defaultMajorModeSource).toEqual({
      baseDirectory: globalDoom,
      filePath: globalModesPath,
    });
    expect(config.majorModeSources).toEqual({
      home: { baseDirectory: globalDoom, filePath: globalModesPath },
      shared: { baseDirectory: root, filePath: repositoryModesPath },
      repo: { baseDirectory: root, filePath: repositoryModesPath },
    });
  });

  it('applies repository null tombstones only to inherited named layers and modes', () => {
    writeGlobalModes(`layers:
  keep: {}
  removed: {}
defaultMajorMode: keep
majorMode:
  keep: [keep]
  removed: [removed]
`);
    writeRepoModes(`layers:
  removed: null
majorMode:
  removed: null
`);

    const config = load();

    expect(Object.keys(config.layers)).toEqual(['keep']);
    expect(Object.keys(config.majorMode)).toEqual(['keep']);
    expect(config.majorModeSources).not.toHaveProperty('removed');
    expect(resolveLayers(config, 'keep')).toEqual(['keep']);
  });

  it('validates surviving defaults and references after applying tombstones', () => {
    writeGlobalModes(`layers:
  removed: {}
defaultMajorMode: removed
majorMode:
  removed: [removed]
  surviving: [removed]
`);
    writeRepoModes('layers:\n  removed: null\n');
    expect(() => load()).toThrow('Unknown layer "removed" in majorMode.removed');

    writeRepoModes('majorMode:\n  removed: null\n');
    expect(() => load()).toThrow('Unknown default major mode "removed"');
  });

  it('falls back to copilot and lets the repository replace a global default', () => {
    writeGlobalModes('layers: {}\ndefaultMajorMode: copilot\nmajorMode:\n  copilot: []\n');
    expect(load().defaultMajorMode).toBe('copilot');

    writeRepoModes('defaultMajorMode: minimal\nmajorMode:\n  minimal: []\n');
    expect(load().defaultMajorMode).toBe('minimal');
  });

  it('uses the compatible copilot fallback when no source declares a default', () => {
    writeRepoModes('layers: {}\nmajorMode:\n  minimal: []\n');

    expect(load().defaultMajorMode).toBe('copilot');
  });

  it('rejects removed targets, invalid major modes, and unknown selections', () => {
    writeRepoModes('layers:\n  guardrails:\n    targets: [copilot]\nmajorMode:\n  copilot: [guardrails]\n');
    expect(() => load()).toThrow('uses removed field "targets"');

    writeRepoModes('layers: {}\nmajorMode:\n  copilot: [missing]\n');
    expect(() => load()).toThrow('Unknown layer "missing"');
    expect(() =>
      resolveLayers(
        {
          layers: {},
          defaultMajorMode: 'copilot',
          majorMode: { copilot: { description: 'Copilot mode.', layers: [] } },
        },
        'missing',
      ),
    ).toThrow('Unknown major mode: missing. Known major modes: copilot');
  });

  it.each([
    ['blank', '" "', 'must be a non-empty string'],
    ['non-string', '7', 'must be a non-empty string'],
    ['unknown', 'missing', 'Unknown default major mode "missing"'],
  ])('rejects a %s configured default major mode', (_name, value, message) => {
    writeRepoModes(`layers: {}\ndefaultMajorMode: ${value}\nmajorMode:\n  copilot: []\n`);

    expect(() => load()).toThrow(message);
  });

  it.each([
    ['missing description', 'layers: []', '.description must be a non-empty string'],
    ['blank description', 'description: " "\n    layers: []', '.description must be a non-empty string'],
    ['missing layers', 'description: Copilot mode.', 'layers in .doom/modes.yaml must be an array'],
    ['invalid layer', 'description: Copilot mode.\n    layers: [7]', 'layers in .doom/modes.yaml[0] must be'],
    ['unknown field', 'description: Copilot mode.\n    layers: []\n    typo: true', 'unsupported field(s): typo'],
  ])('rejects a rich major mode with %s', (_name, definition, message) => {
    writeRepoModes(`layers: {}\nmajorMode:\n  copilot:\n    ${definition}\n`);

    expect(() => load()).toThrow(message);
  });

  it('resolves built-ins, local scripts, and packages in layer order', () => {
    const config: MajorModesConfig = {
      layers: {
        development: {
          baseDirectory: root,
          extensions: ['repositoryHooks', './extensions/custom.ts', './extensions/legacy.js'],
          packages: ['required/pi', { name: 'optional/pi', optional: true }, { name: 'absent/pi', optional: true }],
        },
      },
      defaultMajorMode: 'copilot',
      majorMode: {},
    };
    const resolvers = {
      ownEntry: vi.fn((name: string) => `/own/${name}`),
      packageEntry: vi.fn((name: string) => `/package/${name}`),
      optionalPackageEntry: vi.fn((name: string) => (name === 'optional/pi' ? `/optional/${name}` : undefined)),
      localEntry: vi.fn(() => undefined),
      localEntries: vi.fn((specifier: string, baseDirectory: string) => [path.resolve(baseDirectory, specifier)]),
    };

    expect(layerEntries(config, 'development', resolvers)).toEqual([
      '/own/repositoryHooks',
      path.join(root, 'extensions', 'custom.ts'),
      path.join(root, 'extensions', 'legacy.js'),
      '/package/required/pi',
      '/optional/optional/pi',
    ]);
    expect(resolvers.ownEntry).toHaveBeenCalledOnce();
    expect(resolvers.localEntries).toHaveBeenNthCalledWith(1, './extensions/custom.ts', root);
    expect(resolvers.localEntries).toHaveBeenNthCalledWith(2, './extensions/legacy.js', root);
    expect(() => layerEntries(config, 'missing', resolvers)).toThrow('Unknown layer: missing');
  });

  it('deduplicates hook groups and ignores unknown layers', () => {
    const config: MajorModesConfig = {
      layers: {
        one: { baseDirectory: root, hookGroups: ['shared', 'one'] },
        two: { baseDirectory: root, hookGroups: ['shared', 'two'] },
      },
      defaultMajorMode: 'copilot',
      majorMode: {},
    };
    expect(layerHookGroups(config, ['one', 'missing', 'two'])).toEqual(['shared', 'one', 'two']);
  });

  it('suppresses hook-group layers when hooks are off, without sorting or deduplicating survivors', () => {
    const config: MajorModesConfig = {
      layers: {
        plain: { baseDirectory: root },
        hooks: { baseDirectory: root, hookGroups: ['repository'] },
      },
      defaultMajorMode: 'copilot',
      majorMode: { copilot: { description: 'test', layers: ['plain', 'hooks', 'plain'] } },
    };
    const authored = config.majorMode.copilot?.layers ?? [];

    expect(filterHookDisabledLayers(config, authored, false)).toEqual(['plain', 'plain']);
    const enabled = filterHookDisabledLayers(config, authored, true);
    expect(enabled).toEqual(['plain', 'hooks', 'plain']);
    // A copy, so a caller cannot mutate the parsed configuration through it.
    expect(enabled).not.toBe(authored);
  });

  it('preserves package-owned config and resolves it in layer and package order', () => {
    writeRepoModes(
      `default:
  packages:
    - name: '@agimon-ai/doompi-team'
      config:
        models:
          - model: openai/default
            thinking: medium
layers:
  team:
    packages:
      - name: '@agimon-ai/doompi-team'
        config:
          models:
            - model: " openai/primary "
              thinking: high
          customField: preserved
          nested:
            disabled: null
  economy:
    packages:
      - '@agimon-ai/vibe-lint'
      - name: '@agimon-ai/doompi-team/extensions/pi'
        optional: true
        config:
          models:
            - model: openai/economy
              thinking: minimal
majorMode:
  copilot: [team, economy]
`,
    );

    const config = load();
    expect(config.layers.team?.packages?.[0]).toEqual({
      name: '@agimon-ai/doompi-team',
      config: {
        models: [{ model: ' openai/primary ', thinking: 'high' }],
        customField: 'preserved',
        nested: { disabled: null },
      },
    });
    expect(config.layers.economy?.packages?.[1]).toMatchObject({
      name: '@agimon-ai/doompi-team/extensions/pi',
      optional: true,
    });
    expect(resolvePackageConfigurations(config, resolveLayers(config, 'copilot'), '@agimon-ai/doompi-team')).toEqual([
      {
        layer: 'default',
        specifier: '@agimon-ai/doompi-team',
        config: { models: [{ model: 'openai/default', thinking: 'medium' }] },
        baseDirectory: root,
        filePath: path.join(root, '.doom', 'modes.yaml'),
      },
      {
        layer: 'team',
        specifier: '@agimon-ai/doompi-team',
        config: {
          models: [{ model: ' openai/primary ', thinking: 'high' }],
          customField: 'preserved',
          nested: { disabled: null },
        },
        baseDirectory: root,
        filePath: path.join(root, '.doom', 'modes.yaml'),
      },
      {
        layer: 'economy',
        specifier: '@agimon-ai/doompi-team/extensions/pi',
        config: { models: [{ model: 'openai/economy', thinking: 'minimal' }] },
        baseDirectory: root,
        filePath: path.join(root, '.doom', 'modes.yaml'),
      },
    ]);
  });

  it('rejects ambiguous layer-level config with migration guidance', () => {
    writeRepoModes(
      'layers:\n  team:\n    packages: ["@agimon-ai/doompi-team"]\n    config:\n      subagents: {}\nmajorMode:\n  copilot: [team]\n',
    );

    expect(() => load()).toThrow('uses unsupported field "config"; move it under the package entry that owns it');
  });

  it.each([
    ['non-array extensions', 'extensions: invalid', 'extensions in .doom/modes.yaml must be an array'],
    ['blank extension', 'extensions: [" "]', 'extensions in .doom/modes.yaml[0] must be a non-empty string'],
    ['non-string extension', 'extensions: [7]', 'extensions in .doom/modes.yaml[0] must be a non-empty string'],
    ['non-array packages', 'packages: invalid', 'packages in .doom/modes.yaml must be an array'],
    ['blank package', 'packages: [" "]', 'package[0] in .doom/modes.yaml must be a non-empty string or mapping'],
    ['non-mapping package', 'packages: [7]', 'package[0] in .doom/modes.yaml must be a non-empty string or mapping'],
    ['missing package name', 'packages:\n      - optional: true', 'package[0] in .doom/modes.yaml.name must be'],
    [
      'invalid optional flag',
      'packages:\n      - name: package\n        optional: yes',
      'package[0] in .doom/modes.yaml.optional must be a boolean',
    ],
    [
      'non-mapping package config',
      'packages:\n      - name: package\n        config: invalid',
      'package[0] in .doom/modes.yaml.config must be a mapping',
    ],
    [
      'unknown package field',
      'packages:\n      - name: package\n        typo: true',
      'package[0] in .doom/modes.yaml has unsupported field(s): typo',
    ],
  ])('rejects %s', (_name, layerPackages, message) => {
    writeRepoModes(`layers:\n  team:\n    ${layerPackages}\nmajorMode:\n  copilot: [team]\n`);
    expect(() => load()).toThrow(message);
  });

  it('rejects unknown layers and blank package names while resolving package config', () => {
    const config: MajorModesConfig = { layers: {}, defaultMajorMode: 'copilot', majorMode: {} };
    expect(() => resolvePackageConfigurations(config, ['missing'], '@agimon-ai/doompi-team')).toThrow(
      'Unknown layer: missing',
    );
    expect(() => resolvePackageConfigurations(config, [], ' ')).toThrow('Package name must be a non-empty string');
  });

  it('reads the global config when the repository has none', () => {
    writeGlobalModes('layers:\n  guardrails: {}\nmajorMode:\n  copilot: [guardrails]\n');

    const config = load();

    expect(resolveLayers(config, 'copilot')).toEqual(['guardrails']);
    expect(config.layers.guardrails?.baseDirectory).toBe(globalDoom);
  });

  it('lets a repository replace a global layer while inheriting the rest', () => {
    writeGlobalModes(
      'layers:\n  guardrails:\n    hookGroups: [global]\n  extra:\n    hookGroups: [extra]\nmajorMode:\n  copilot: [guardrails, extra]\n',
    );
    writeRepoModes('layers:\n  guardrails:\n    hookGroups: [repo]\n');

    const config = load();

    // The repository owns guardrails outright; extra and the mode are inherited.
    expect(config.layers.guardrails?.hookGroups).toEqual(['repo']);
    expect(config.layers.guardrails?.baseDirectory).toBe(root);
    expect(config.layers.extra?.baseDirectory).toBe(globalDoom);
    expect(layerHookGroups(config, resolveLayers(config, 'copilot'))).toEqual(['repo', 'extra']);
  });

  it('resolves a path-style package against the config that declared it', () => {
    writeGlobalModes("layers:\n  private:\n    packages: ['./extensions/mine']\nmajorMode:\n  solo: [private]\n");

    const resolvers = {
      ownEntry: vi.fn((name: string) => `/own/${name}`),
      packageEntry: vi.fn((name: string) => `/package/${name}`),
      optionalPackageEntry: vi.fn(() => undefined),
      localEntry: vi.fn((specifier: string, baseDirectory: string) => path.join(baseDirectory, specifier, 'index.mjs')),
    };

    expect(layerEntries(load(), 'private', resolvers)).toEqual([
      path.join(globalDoom, './extensions/mine', 'index.mjs'),
    ]);
    // Never handed to npm resolution, so an unpublished name cannot be hijacked.
    expect(resolvers.packageEntry).not.toHaveBeenCalled();
  });

  it('fails a required path-style package that does not resolve, and skips an optional one', () => {
    writeRepoModes(
      "layers:\n  broken:\n    packages: ['./missing']\n  tolerant:\n    packages:\n      - name: './missing'\n        optional: true\n",
    );
    const resolvers = {
      ownEntry: vi.fn((name: string) => `/own/${name}`),
      packageEntry: vi.fn((name: string) => `/package/${name}`),
      optionalPackageEntry: vi.fn(() => undefined),
      localEntry: vi.fn(() => undefined),
    };
    const config = load();

    expect(() => layerEntries(config, 'broken', resolvers)).toThrow('does not resolve under');
    expect(layerEntries(config, 'tolerant', resolvers)).toEqual([]);
  });

  it('fails a path-style extension that does not resolve without treating it as a built-in', () => {
    writeRepoModes("layers:\n  broken:\n    extensions: ['./missing.ts']\n");
    const resolvers = {
      ownEntry: vi.fn((name: string) => `/own/${name}`),
      packageEntry: vi.fn((name: string) => `/package/${name}`),
      optionalPackageEntry: vi.fn(() => undefined),
      localEntry: vi.fn(() => undefined),
    };

    expect(() => layerEntries(load(), 'broken', resolvers)).toThrow('extension "./missing.ts" does not resolve under');
    expect(resolvers.ownEntry).not.toHaveBeenCalled();
  });
});
