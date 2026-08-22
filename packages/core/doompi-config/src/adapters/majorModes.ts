import os from 'node:os';
import path from 'node:path';
import { DOOM_DIR, type DoomConfigProvenance, readDoomConfigSources } from './layeredConfig.ts';

export type LayerPackageConfig = Record<string, unknown>;

/** One package selected by a layer, plus configuration owned by that package. */
export interface LayerPackage {
  name: string;
  optional?: boolean;
  config?: LayerPackageConfig;
}

/** One configured package found while walking selected layers in order. */
export interface ResolvedPackageConfiguration {
  layer: string;
  specifier: string;
  config: LayerPackageConfig;
  baseDirectory: string;
  filePath?: string;
}

export interface LayerDefinition {
  /**
   * DoomPi built-in names, or Pi-compatible local extension paths.
   * Bare names resolve from DoomPi's own extension entries. Paths beginning
   * with `./` or `../`, plus absolute paths, resolve against the config that
   * declares the layer and may name a script file or extension directory.
   */
  extensions?: string[];
  /**
   * npm specifiers, or local package paths retained for compatibility.
   * Relative paths resolve against the repository root for `.doom/modes.yaml`
   * and against the global `.doom` directory for
   * `~/.pi/.doom/modes.yaml`.
   */
  packages?: Array<string | LayerPackage>;
  hookGroups?: string[];
}

/** A layer plus the root its relative extension and package paths resolve against. */
export interface ResolvedLayerDefinition extends LayerDefinition {
  baseDirectory: string;
  /** Absolute path of the modes file that declared this layer. */
  filePath?: string;
}

export interface MajorModeDefinition {
  /** Human-readable purpose used by pickers and agent-facing catalogs. */
  description: string;
  /** Ordered layer names activated by this mode. */
  layers: string[];
}

export interface MajorModesConfig {
  /** Unconditional package bundle loaded before packages from selected named layers. */
  default?: ResolvedLayerDefinition;
  layers: Record<string, ResolvedLayerDefinition>;
  /** The mode selected when neither a flag nor the environment names one. */
  defaultMajorMode: string;
  /** Source that last declared the default, absent for the built-in fallback. */
  defaultMajorModeSource?: DoomConfigProvenance;
  /** Named major modes, including their purpose and ordered layers. */
  majorMode: Record<string, MajorModeDefinition>;
  /** Declaring source for each surviving named mode. */
  majorModeSources?: Record<string, DoomConfigProvenance>;
}

export interface LayerResolvers {
  ownEntry: (name: string) => string;
  packageEntry: (name: string) => string;
  optionalPackageEntry: (name: string) => string | undefined;
  /** Resolves every standard package.json pi.extensions entry for a package root. */
  packageEntries?: (name: string) => string[];
  /** Optional counterpart to packageEntries. */
  optionalPackageEntries?: (name: string) => string[] | undefined;
  /** Resolves one path-style layer entry against the config that declared it. */
  localEntry: (specifier: string, baseDirectory: string) => string | undefined;
  /** Resolves every Pi extension entry contributed by a local file or directory. */
  localEntries?: (specifier: string, baseDirectory: string) => string[] | undefined;
}

interface ModesDocument {
  default?: unknown;
  layers?: unknown;
  defaultMajorMode?: unknown;
  majorMode?: unknown;
}

const MODES_FILE = 'modes.yaml';
const FALLBACK_MAJOR_MODE = 'copilot';
const MAJOR_MODES_RELATIVE_PATH = path.join(DOOM_DIR, MODES_FILE);
const RELATIVE_PREFIXES = ['./', '../'] as const;
const DEFAULT_KEYS = ['packages'] as const;

/**
 * Whether a layer value names a path rather than a built-in or installed package.
 *
 * The same rule Node applies to import specifiers, so a bare name is always a
 * logical name and a path always looks like one.
 */
export function isLocalPackageSpecifier(specifier: string): boolean {
  return path.isAbsolute(specifier) || RELATIVE_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}
const LAYER_PACKAGE_KEYS = ['name', 'optional', 'config'] as const;
const MAJOR_MODE_KEYS = ['description', 'layers'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], location: string): void {
  const unsupported = Object.keys(value).filter((key) => !keys.includes(key));
  if (unsupported.length > 0) {
    throw new Error(`${location} has unsupported field(s): ${unsupported.join(', ')}`);
  }
}

function parseLayerPackage(layerName: string, value: unknown, index: number): string | LayerPackage {
  const location = `Layer "${layerName}" package[${index}] in ${MAJOR_MODES_RELATIVE_PATH}`;
  if (typeof value === 'string') {
    if (!value.trim()) throw new Error(`${location} must be a non-empty string or mapping`);
    return value.trim();
  }
  if (!isRecord(value)) throw new Error(`${location} must be a non-empty string or mapping`);
  assertKnownKeys(value, LAYER_PACKAGE_KEYS, location);
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error(`${location}.name must be a non-empty string`);
  }
  if (value.optional !== undefined && typeof value.optional !== 'boolean') {
    throw new Error(`${location}.optional must be a boolean`);
  }
  if (value.config !== undefined && !isRecord(value.config)) {
    throw new Error(`${location}.config must be a mapping`);
  }
  return {
    name: value.name.trim(),
    ...(value.optional === true ? { optional: true } : {}),
    ...(value.config ? { config: { ...value.config } } : {}),
  };
}

function parseLayerExtensions(layerName: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const location = `Layer "${layerName}" extensions in ${MAJOR_MODES_RELATIVE_PATH}`;
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${location}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

function parseLayerPackages(layerName: string, value: unknown): Array<string | LayerPackage> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Layer "${layerName}" packages in ${MAJOR_MODES_RELATIVE_PATH} must be an array`);
  }
  return value.map((entry, index) => parseLayerPackage(layerName, entry, index));
}

function parseDefaultMajorMode(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`defaultMajorMode in ${MAJOR_MODES_RELATIVE_PATH} must be a non-empty string`);
  }
  return value.trim();
}

function parseMajorModeLayers(modeName: string, value: unknown): string[] {
  const location = `Major mode "${modeName}" layers in ${MAJOR_MODES_RELATIVE_PATH}`;
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  return value.map((layerName, index) => {
    if (typeof layerName !== 'string' || !layerName.trim()) {
      throw new Error(`${location}[${index}] must be a non-empty string`);
    }
    return layerName.trim();
  });
}

function legacyMajorModeDescription(layers: readonly string[]): string {
  return layers.length > 0 ? `Uses layers: ${layers.join(', ')}.` : 'Uses Doom Pi core extensions only.';
}

function parseMajorMode(name: string, value: unknown): MajorModeDefinition {
  if (Array.isArray(value)) {
    const layers = parseMajorModeLayers(name, value);
    return { description: legacyMajorModeDescription(layers), layers };
  }

  const location = `Major mode "${name}" in ${MAJOR_MODES_RELATIVE_PATH}`;
  if (!isRecord(value)) throw new Error(`${location} must be a mapping with description and layers`);
  assertKnownKeys(value, MAJOR_MODE_KEYS, location);
  if (typeof value.description !== 'string' || !value.description.trim()) {
    throw new Error(`${location}.description must be a non-empty string`);
  }
  return {
    description: value.description.trim(),
    layers: parseMajorModeLayers(name, value.layers),
  };
}

function parseMajorModes(value: unknown): Record<string, MajorModeDefinition | null> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`majorMode in ${MAJOR_MODES_RELATIVE_PATH} must be a mapping`);
  return Object.fromEntries(
    Object.entries(value).map(([name, definition]) => [
      name,
      definition === null ? null : parseMajorMode(name, definition),
    ]),
  );
}

function parseLayer(name: string, definition: unknown): LayerDefinition {
  if (!isRecord(definition)) throw new Error(`Layer "${name}" in ${MAJOR_MODES_RELATIVE_PATH} must be a mapping`);
  if ('targets' in definition) {
    throw new Error(
      `Layer "${name}" in ${MAJOR_MODES_RELATIVE_PATH} uses removed field "targets"; select availability through major modes`,
    );
  }
  if ('config' in definition) {
    throw new Error(
      `Layer "${name}" in ${MAJOR_MODES_RELATIVE_PATH} uses unsupported field "config"; move it under the package entry that owns it`,
    );
  }
  const extensions = parseLayerExtensions(name, definition.extensions);
  const packages = parseLayerPackages(name, definition.packages);
  return {
    ...definition,
    ...(extensions === undefined ? {} : { extensions }),
    ...(packages === undefined ? {} : { packages }),
  } as LayerDefinition;
}

function parseLayers(value: unknown): Record<string, LayerDefinition | null> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`layers in ${MAJOR_MODES_RELATIVE_PATH} must be a mapping`);
  return Object.fromEntries(
    Object.entries(value).map(([name, definition]) => [
      name,
      definition === null ? null : parseLayer(name, definition),
    ]),
  );
}

function parseDefault(value: unknown): LayerDefinition {
  const location = `default in ${MAJOR_MODES_RELATIVE_PATH}`;
  if (!isRecord(value)) throw new Error(`${location} must be a mapping with packages`);
  assertKnownKeys(value, DEFAULT_KEYS, location);
  if (!Object.hasOwn(value, 'packages')) {
    throw new Error(`Layer "default" packages in ${MAJOR_MODES_RELATIVE_PATH} must be an array`);
  }
  const packages = parseLayerPackages('default', value.packages);
  return { packages };
}

/**
 * Reads layers and major modes from the global and repository configs.
 *
 * The repository is read last, so it replaces a global layer or major mode of
 * the same name. Layers keep the root they were declared under so that a
 * global layer naming `./extensions/x` still points beside the global config
 * once it is loaded from inside some other repository.
 */
export function loadMajorModesConfig(repoRoot: string, homeDirectory: string = os.homedir()): MajorModesConfig {
  const sources = readDoomConfigSources<ModesDocument>(MODES_FILE, repoRoot, homeDirectory);
  let defaultDefinition: ResolvedLayerDefinition | undefined;
  const layers: Record<string, ResolvedLayerDefinition> = {};
  const majorMode: Record<string, MajorModeDefinition> = {};
  const majorModeSources: Record<string, DoomConfigProvenance> = {};
  let defaultMajorMode = FALLBACK_MAJOR_MODE;
  let defaultMajorModeSource: DoomConfigProvenance | undefined;
  let hasConfiguredDefault = false;
  for (const source of sources) {
    if (Object.hasOwn(source.document, 'default')) {
      defaultDefinition = {
        ...parseDefault(source.document.default),
        baseDirectory: source.baseDirectory,
        filePath: source.filePath,
      };
    }
    for (const [name, definition] of Object.entries(parseLayers(source.document.layers))) {
      if (definition === null) {
        delete layers[name];
        continue;
      }
      layers[name] = {
        ...definition,
        baseDirectory: source.baseDirectory,
        filePath: source.filePath,
      };
    }
    if (Object.hasOwn(source.document, 'defaultMajorMode')) {
      defaultMajorMode = parseDefaultMajorMode(source.document.defaultMajorMode);
      defaultMajorModeSource = { filePath: source.filePath, baseDirectory: source.baseDirectory };
      hasConfiguredDefault = true;
    }
    for (const [name, definition] of Object.entries(parseMajorModes(source.document.majorMode))) {
      if (definition === null) {
        delete majorMode[name];
        delete majorModeSources[name];
        continue;
      }
      majorMode[name] = definition;
      majorModeSources[name] = { filePath: source.filePath, baseDirectory: source.baseDirectory };
    }
  }

  for (const [modeName, definition] of Object.entries(majorMode)) {
    for (const name of definition.layers) {
      if (!layers[name]) {
        throw new Error(`Unknown layer "${name}" in majorMode.${modeName} of ${MAJOR_MODES_RELATIVE_PATH}`);
      }
    }
  }
  if (hasConfiguredDefault && !Object.hasOwn(majorMode, defaultMajorMode)) {
    throw new Error(`Unknown default major mode "${defaultMajorMode}" in ${MAJOR_MODES_RELATIVE_PATH}`);
  }
  return {
    ...(defaultDefinition ? { default: defaultDefinition } : {}),
    layers,
    defaultMajorMode,
    ...(defaultMajorModeSource ? { defaultMajorModeSource } : {}),
    majorMode,
    majorModeSources,
  };
}

/** Finds configuration owned by one package while preserving layer and package order. */
export function resolvePackageConfigurations(
  config: MajorModesConfig,
  names: string[],
  packageName: string,
): ResolvedPackageConfiguration[] {
  const normalizedPackageName = packageName.trim();
  if (!normalizedPackageName) throw new Error('Package name must be a non-empty string');
  const configurations: ResolvedPackageConfiguration[] = [];
  const definitions: Array<{ name: string; definition: ResolvedLayerDefinition }> = [];
  if (config.default) definitions.push({ name: 'default', definition: config.default });
  for (const name of names) {
    const definition = config.layers[name];
    if (!definition) throw new Error(`Unknown layer: ${name}`);
    definitions.push({ name, definition });
  }
  for (const { name, definition } of definitions) {
    for (const entry of definition.packages ?? []) {
      if (typeof entry === 'string' || entry.config === undefined) continue;
      if (entry.name !== normalizedPackageName && !entry.name.startsWith(`${normalizedPackageName}/`)) continue;
      configurations.push({
        layer: name,
        specifier: entry.name,
        config: { ...entry.config },
        baseDirectory: definition.baseDirectory,
        ...(definition.filePath ? { filePath: definition.filePath } : {}),
      });
    }
  }
  return configurations;
}

/** Resolves one named major mode into its configured layer components. */
export function resolveLayers(config: MajorModesConfig, majorMode: string): string[] {
  if (!Object.hasOwn(config.majorMode, majorMode)) {
    throw new Error(
      `Unknown major mode: ${majorMode}. Known major modes: ${Object.keys(config.majorMode).sort().join(', ')}`,
    );
  }
  return [...config.majorMode[majorMode]!.layers];
}

function resolveLocalEntries(
  resolvers: LayerResolvers,
  specifier: string,
  baseDirectory: string,
): string[] | undefined {
  const resolved = resolvers.localEntries?.(specifier, baseDirectory);
  if (resolved !== undefined) return resolved;
  const single = resolvers.localEntry(specifier, baseDirectory);
  return single ? [single] : undefined;
}

/** Resolves one layer's extension and package entries to absolute paths. */
export function layerEntries(config: MajorModesConfig, name: string, resolvers: LayerResolvers): string[] {
  const layer = config.layers[name];
  if (!layer) throw new Error(`Unknown layer: ${name}`);
  const entries: string[] = [];
  for (const entry of layer.extensions ?? []) {
    if (!isLocalPackageSpecifier(entry)) {
      entries.push(resolvers.ownEntry(entry));
      continue;
    }
    const resolved = resolveLocalEntries(resolvers, entry, layer.baseDirectory);
    if (!resolved?.length) {
      throw new Error(
        `Layer "${name}" extension "${entry}" does not resolve under ${layer.baseDirectory}. ` +
          'Point it at a Pi extension file or directory.',
      );
    }
    entries.push(...resolved);
  }
  for (const entry of layer.packages ?? []) {
    const specifier = typeof entry === 'string' ? entry : entry.name;
    const optional = typeof entry === 'string' ? false : entry.optional === true;
    if (isLocalPackageSpecifier(specifier)) {
      const resolved = resolveLocalEntries(resolvers, specifier, layer.baseDirectory);
      if (resolved?.length) entries.push(...resolved);
      else if (!optional) {
        throw new Error(
          `Layer "${name}" package "${specifier}" does not resolve under ${layer.baseDirectory}. ` +
            'Point it at an extension file, or a directory whose package.json declares pi.extensions.',
        );
      }
      continue;
    }
    if (optional) {
      let resolved = resolvers.optionalPackageEntries?.(specifier);
      if (resolved === undefined) {
        const single = resolvers.optionalPackageEntry(specifier);
        resolved = single ? [single] : undefined;
      }
      if (resolved) entries.push(...resolved);
      continue;
    }
    const resolved = resolvers.packageEntries?.(specifier) ?? [resolvers.packageEntry(specifier)];
    if (resolved.length === 0) {
      throw new Error(`Layer "${name}" package "${specifier}" declares no Pi extensions.`);
    }
    entries.push(...resolved);
  }
  return entries;
}

/** Hook group ids contributed by the selected layers, deduped. */
export function layerHookGroups(config: MajorModesConfig, names: string[]): string[] {
  const groups = new Set<string>();
  for (const name of names) {
    for (const group of config.layers[name]?.hookGroups ?? []) groups.add(group);
  }
  return [...groups];
}

/**
 * Suppress layers that exist to contribute hook groups when hooks are disabled.
 *
 * Lives beside layerHookGroups because it is the inverse question about the same
 * field, and because every caller that resolves layers has to ask it.
 */
export function filterHookDisabledLayers(
  config: MajorModesConfig,
  layers: readonly string[],
  hooks: boolean,
): string[] {
  if (hooks) return [...layers];
  return layers.filter((layer) => (config.layers[layer]?.hookGroups?.length ?? 0) === 0);
}
