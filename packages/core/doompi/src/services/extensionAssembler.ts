import {
  isLocalPackageSpecifier,
  type LayerResolvers,
  type MajorModesConfig,
} from '@agimon-ai/doompi-config/majorModes';
import type { PackageAttribution } from '@agimon-ai/doompi-config/types';
import {
  consumerPackageEntries,
  consumerPackageEntry,
  localEntries,
  localEntry,
  localPackageEntries,
  ownEntry,
  localPackageName as resolveLocalPackageName,
  optionalPackageEntries as resolveOptionalPackageEntries,
  optionalPackageEntry as resolveOptionalPackageEntry,
  packageEntries as resolvePackageEntries,
  packageEntry as resolvePackageEntry,
} from '../adapters/modules/moduleResolution';
import { canonicalModulePath, sha256 } from '../adapters/runtimeIdentity';

export interface ExtensionLayerResolvers extends LayerResolvers {
  /** Resolves a path authored under packages through its standard Pi manifest. */
  localPackageEntries?: (specifier: string, baseDirectory: string) => string[] | undefined;
  /** Canonical manifest name for a path that represents a package directory. */
  localPackageName?: (specifier: string, baseDirectory: string) => string | undefined;
}

export interface ExtensionContext {
  agents: boolean;
  autoStop: boolean;
  mute?: boolean;
  preset?: string;
  personaEntry?: string;
  /** Named mode whose occurrence is part of composition identity. */
  majorMode?: string;
  /** Ordered layer occurrences selected by the active major mode. */
  layers: string[];
  majorModesConfig: MajorModesConfig;
  /** Resolver override used by synchronized replay. */
  resolvers?: ExtensionLayerResolvers;
}

export type SelectedEntryKind = 'extension' | 'package';
type ExtensionResolutionOutcome = 'resolved' | 'missing-optional';

/**
 * One resolver-derived extension occurrence.
 *
 * This remains private to DoomPi composition. It is not package metadata and
 * deliberately retains authored duplicates even though activation paths are
 * deduplicated later.
 */
interface ResolvedExtensionSelection {
  readonly layer: string;
  readonly layerIndex: number;
  readonly entryKind: SelectedEntryKind;
  readonly entryIndex: number;
  readonly manifestIndex: number;
  readonly selector: string;
  readonly sourceFile?: string;
  readonly baseDirectory: string;
  readonly optional: boolean;
  readonly outcome: ExtensionResolutionOutcome;
  readonly path?: string;
  readonly canonicalPath?: string;
  readonly diagnostic?: string;
  readonly config?: Record<string, unknown>;
}

export interface CompositionLayerOccurrence {
  readonly name: string;
  readonly index: number;
  readonly sourceFile?: string;
  readonly baseDirectory: string;
}

/** Internal normalized composition shared by launch, sync, bundles, and replay. */
export interface ExtensionComposition {
  readonly version: number;
  readonly majorMode?: {
    readonly name: string;
    readonly sourceFile?: string;
    readonly baseDirectory?: string;
  };
  readonly layers: readonly CompositionLayerOccurrence[];
  readonly selections: readonly ResolvedExtensionSelection[];
  /** Actual Pi factory activation order, not CLI argument construction order. */
  readonly parentActivation: readonly string[];
  /** Actual Pi factory activation order inherited by detached children. */
  readonly childActivation: readonly string[];
  readonly fingerprint: string;
}

/**
 * Which layer of which major mode admitted each package.
 *
 * The composition already holds this join while it resolves package names to
 * entry paths, then drops it, so a session cannot afterwards say why a tool is
 * present. Reducing it here keeps the selection type private and costs one pass
 * over an array the caller already has.
 *
 * Only `package` entries appear. A bare `extension` selector is a path rather
 * than a package name, so it has nothing a registered tool could be joined on.
 */
export function packageAttribution(composition: ExtensionComposition): Record<string, PackageAttribution> {
  const attribution: Record<string, PackageAttribution> = {};
  const mode = composition.majorMode?.name;
  if (mode === undefined) return attribution;
  for (const selection of composition.selections) {
    if (selection.entryKind !== 'package') continue;
    if (selection.outcome !== 'resolved') continue;
    // First layer wins, matching activation order: the earlier layer is the one
    // whose copy of a duplicated package actually loaded.
    if (attribution[selection.selector] !== undefined) continue;
    attribution[selection.selector] = { kind: 'major', mode, layer: selection.layer };
  }
  return attribution;
}
export const COMPOSITION_FINGERPRINT_VERSION = 4;
export const STANDARD_PI_EXTENSION_CONTRACT_VERSION = 2;

const DEFAULT_SELECTION_LAYER = 'default';
const DEFAULT_SELECTION_LAYER_INDEX = -1;

const FIXED_CORE_PACKAGES = new Set([
  '@agimon-ai/doompi',
  '@agimon-ai/doompi-autostop',
  '@agimon-ai/doompi-cache',
  '@agimon-ai/doompi-config',
  '@agimon-ai/doompi-domain',
  '@agimon-ai/doompi-major-mode',
  '@agimon-ai/doompi-notification',
  '@agimon-ai/doompi-profile',
  '@agimon-ai/doompi-skill',
  '@agimon-ai/doompi-ui',
]);

const OWN_ENTRIES = {
  cordisFinalizer: 'cordisFinalizer',
  cordisHost: 'cordisHost',
  effort: 'effort',
  modeCatalog: 'modeCatalog',
  ollamaProvider: 'ollamaProvider',
  transitionCoordinator: 'transitionCoordinator',
} as const;

const CORE_PACKAGE_ENTRIES = {
  autostop: '@agimon-ai/doompi-autostop/extensions/pi',
  cache: '@agimon-ai/doompi-cache/extensions/pi',
  config: '@agimon-ai/doompi-config/extensions/pi',
  domain: '@agimon-ai/doompi-domain/extensions/pi',
  majorMode: '@agimon-ai/doompi-major-mode/extensions/pi',
  notification: '@agimon-ai/doompi-notification/extensions/pi',
  profile: '@agimon-ai/doompi-profile/extensions/pi',
  skill: '@agimon-ai/doompi-skill/extensions/pi',
  ui: '@agimon-ai/doompi-ui/extensions/pi',
} as const;

export const OLLAMA_PRESET = 'ollama';

/**
 * Always available so /profile can pick a persona later, and the one entry a
 * detached child shares with its parent: children get the persona without the
 * command, because they have no transition coordinator to run a switch through.
 *
 * An explicit subpath rather than the bare package name, so it resolves to
 * exactly this file rather than to whatever pi.extensions lists.
 */
export const PERSONA_ENTRY = '@agimon-ai/doompi-profile/extensions/persona';

export const LAYER_RESOLVERS: ExtensionLayerResolvers = {
  ownEntry,
  packageEntry: resolvePackageEntry,
  optionalPackageEntry: resolveOptionalPackageEntry,
  packageEntries: resolvePackageEntries,
  optionalPackageEntries: resolveOptionalPackageEntries,
  localEntry,
  localEntries,
  localPackageEntries,
  localPackageName: resolveLocalPackageName,
};

function missingConsumerPackage(name: string, consumerRoot: string): Error {
  return new Error(`Cannot resolve configured package "${name}" from ${consumerRoot}.`);
}

/**
 * Resolves configured packages only from the consumer, while fixed core entries
 * may fall back to the host package's private dependency closure.
 */
export function createLayerResolvers(consumerRoot?: string): ExtensionLayerResolvers {
  if (!consumerRoot) return LAYER_RESOLVERS;
  const fallbackEntry = (name: string): string | undefined =>
    FIXED_CORE_PACKAGES.has(packageName(name)) ? resolveOptionalPackageEntry(name) : undefined;
  const fallbackEntries = (name: string): string[] | undefined =>
    FIXED_CORE_PACKAGES.has(packageName(name)) ? resolveOptionalPackageEntries(name) : undefined;
  const requiredEntry = (name: string): string => {
    const entry = consumerPackageEntry(name, consumerRoot) ?? fallbackEntry(name);
    if (!entry) throw missingConsumerPackage(name, consumerRoot);
    return entry;
  };
  const requiredEntries = (name: string): string[] => {
    const entries = consumerPackageEntries(name, consumerRoot) ?? fallbackEntries(name);
    if (!entries) throw missingConsumerPackage(name, consumerRoot);
    return entries;
  };
  return {
    ownEntry,
    packageEntry: requiredEntry,
    optionalPackageEntry: (name) => consumerPackageEntry(name, consumerRoot) ?? fallbackEntry(name),
    packageEntries: requiredEntries,
    optionalPackageEntries: (name) => consumerPackageEntries(name, consumerRoot) ?? fallbackEntries(name),
    localEntry,
    localEntries,
    localPackageEntries,
    localPackageName: resolveLocalPackageName,
  };
}

function packageName(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier);
}

function assertFeaturePackage(specifier: string, layer: string): void {
  const selectedPackage = packageName(specifier);
  if (FIXED_CORE_PACKAGES.has(selectedPackage)) {
    throw new Error(
      `Layer "${layer}" cannot select fixed DoomPi host package "${selectedPackage}" as a feature extension.`,
    );
  }
}

function resolveLocalExtensionEntries(
  resolvers: ExtensionLayerResolvers,
  specifier: string,
  baseDirectory: string,
): string[] | undefined {
  const resolved = resolvers.localEntries?.(specifier, baseDirectory);
  if (resolved !== undefined) return resolved;
  const single = resolvers.localEntry(specifier, baseDirectory);
  return single ? [single] : undefined;
}

function resolveLocalPackageSelections(
  resolvers: ExtensionLayerResolvers,
  specifier: string,
  baseDirectory: string,
): string[] | undefined {
  const resolved = resolvers.localPackageEntries?.(specifier, baseDirectory);
  if (resolved !== undefined) return resolved;
  return resolveLocalExtensionEntries(resolvers, specifier, baseDirectory);
}

interface SelectionIdentity {
  layer: string;
  layerIndex: number;
  entryKind: SelectedEntryKind;
  entryIndex: number;
  selector: string;
  sourceFile?: string;
  baseDirectory: string;
  optional: boolean;
  config?: Record<string, unknown>;
}

function resolvedSelection(
  identity: SelectionIdentity,
  manifestIndex: number,
  resolvedPath: string,
): ResolvedExtensionSelection {
  return {
    ...identity,
    manifestIndex,
    outcome: 'resolved',
    path: resolvedPath,
    canonicalPath: canonicalModulePath(resolvedPath),
  };
}

function missingOptionalSelection(identity: SelectionIdentity, diagnostic: string): ResolvedExtensionSelection {
  return {
    ...identity,
    manifestIndex: 0,
    outcome: 'missing-optional',
    diagnostic,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveDefinitionSelections(
  definition: MajorModesConfig['layers'][string],
  layer: string,
  layerIndex: number,
  resolvers: ExtensionLayerResolvers,
): ResolvedExtensionSelection[] {
  const resolvedSelections: ResolvedExtensionSelection[] = [];
  const extensionEntries = definition.extensions ?? [];
  for (const [entryIndex, selector] of extensionEntries.entries()) {
    const identity: SelectionIdentity = {
      layer,
      layerIndex,
      entryKind: 'extension',
      entryIndex,
      selector,
      ...(definition.filePath ? { sourceFile: definition.filePath } : {}),
      baseDirectory: definition.baseDirectory,
      optional: false,
    };
    if (!isLocalPackageSpecifier(selector)) {
      resolvedSelections.push(resolvedSelection(identity, 0, resolvers.ownEntry(selector)));
      continue;
    }
    const resolved = resolveLocalExtensionEntries(resolvers, selector, definition.baseDirectory);
    if (!resolved?.length) {
      throw new Error(
        `Layer "${layer}" extension "${selector}" does not resolve under ${definition.baseDirectory}. ` +
          'Point it at a Pi extension file or directory.',
      );
    }
    resolved.forEach((resolvedPath, manifestIndex) => {
      resolvedSelections.push(resolvedSelection(identity, manifestIndex, resolvedPath));
    });
  }

  const packageOffset = extensionEntries.length;
  for (const [packageIndex, configured] of (definition.packages ?? []).entries()) {
    const selector = typeof configured === 'string' ? configured : configured.name;
    const optional = typeof configured === 'string' ? false : configured.optional === true;
    const configValue = typeof configured === 'string' ? undefined : configured.config;
    const identity: SelectionIdentity = {
      layer,
      layerIndex,
      entryKind: 'package',
      entryIndex: packageOffset + packageIndex,
      selector,
      ...(definition.filePath ? { sourceFile: definition.filePath } : {}),
      baseDirectory: definition.baseDirectory,
      optional,
      ...(configValue === undefined ? {} : { config: configValue }),
    };

    let resolved: string[] | undefined;
    try {
      if (isLocalPackageSpecifier(selector)) {
        const manifestName = resolvers.localPackageName?.(selector, definition.baseDirectory);
        if (manifestName) assertFeaturePackage(manifestName, layer);
        resolved = resolveLocalPackageSelections(resolvers, selector, definition.baseDirectory);
      } else {
        assertFeaturePackage(selector, layer);
        if (optional) {
          resolved = resolvers.optionalPackageEntries?.(selector);
          if (resolved === undefined && !resolvers.optionalPackageEntries) {
            const single = resolvers.optionalPackageEntry(selector);
            resolved = single ? [single] : undefined;
          }
        } else {
          resolved = resolvers.packageEntries?.(selector) ?? [resolvers.packageEntry(selector)];
        }
      }
    } catch (error) {
      if (optional) {
        resolvedSelections.push(missingOptionalSelection(identity, errorMessage(error)));
        continue;
      }
      throw error;
    }

    if (!resolved?.length) {
      if (optional) {
        resolvedSelections.push(
          missingOptionalSelection(
            identity,
            `Optional package "${selector}" is unavailable or declares no Pi extensions.`,
          ),
        );
        continue;
      }
      if (isLocalPackageSpecifier(selector)) {
        throw new Error(
          `Layer "${layer}" package "${selector}" does not resolve under ${definition.baseDirectory}. ` +
            'Point it at an extension file, or a directory whose package.json declares pi.extensions.',
        );
      }
      throw new Error(`Layer "${layer}" package "${selector}" declares no Pi extensions.`);
    }

    resolved.forEach((resolvedPath, manifestIndex) => {
      resolvedSelections.push(resolvedSelection(identity, manifestIndex, resolvedPath));
    });
  }

  return resolvedSelections;
}

function resolveLayerSelections(
  config: MajorModesConfig,
  layer: string,
  layerIndex: number,
  resolvers: ExtensionLayerResolvers,
): ResolvedExtensionSelection[] {
  const definition = config.layers[layer];
  if (!definition) throw new Error(`Unknown layer: ${layer}`);
  return resolveDefinitionSelections(definition, layer, layerIndex, resolvers);
}

function resolveDefaultSelections(
  config: MajorModesConfig,
  resolvers: ExtensionLayerResolvers,
): ResolvedExtensionSelection[] {
  if (!config.default) return [];
  return resolveDefinitionSelections(config.default, DEFAULT_SELECTION_LAYER, DEFAULT_SELECTION_LAYER_INDEX, resolvers);
}

function resolveSelectedExtensions(context: ExtensionContext): ResolvedExtensionSelection[] {
  const resolvers = context.resolvers ?? LAYER_RESOLVERS;
  return context.layers.flatMap((layer, layerIndex) =>
    resolveLayerSelections(context.majorModesConfig, layer, layerIndex, resolvers),
  );
}

function deduplicatePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const entry of paths) {
    const identity = canonicalModulePath(entry);
    if (seen.has(identity)) continue;
    seen.add(identity);
    selected.push(entry);
  }
  return selected;
}

function selectedFeaturePaths(selections: readonly ResolvedExtensionSelection[]): string[] {
  return deduplicatePaths(
    selections.flatMap((entry) => (entry.outcome === 'resolved' && entry.path ? [entry.path] : [])),
  );
}

function parentActivation(
  context: ExtensionContext,
  distributionPaths: readonly string[],
  featurePaths: readonly string[],
): string[] {
  const resolve = context.resolvers ?? LAYER_RESOLVERS;
  const activation = [
    resolve.ownEntry(OWN_ENTRIES.cordisHost),
    resolve.ownEntry(OWN_ENTRIES.modeCatalog),
    resolve.packageEntry(CORE_PACKAGE_ENTRIES.config),
    resolve.ownEntry(OWN_ENTRIES.transitionCoordinator),
    resolve.packageEntry(CORE_PACKAGE_ENTRIES.ui),
  ];
  if (!context.mute) activation.push(resolve.packageEntry(CORE_PACKAGE_ENTRIES.notification));
  activation.push(
    resolve.packageEntry(CORE_PACKAGE_ENTRIES.profile),
    resolve.packageEntry(CORE_PACKAGE_ENTRIES.majorMode),
    resolve.packageEntry(CORE_PACKAGE_ENTRIES.skill),
    resolve.packageEntry(CORE_PACKAGE_ENTRIES.domain),
    resolve.ownEntry(OWN_ENTRIES.effort),
  );
  if (context.preset === OLLAMA_PRESET) activation.push(resolve.ownEntry(OWN_ENTRIES.ollamaProvider));
  activation.push(...distributionPaths, ...featurePaths);
  if (context.personaEntry) activation.push(context.personaEntry);
  if (context.autoStop) activation.push(resolve.packageEntry(CORE_PACKAGE_ENTRIES.autostop));
  activation.push(resolve.packageEntry(CORE_PACKAGE_ENTRIES.cache));
  activation.push(resolve.ownEntry(OWN_ENTRIES.cordisFinalizer));
  return deduplicatePaths(activation);
}

function childActivation(
  context: ExtensionContext,
  distributionPaths: readonly string[],
  featurePaths: readonly string[],
): string[] {
  const resolve = context.resolvers ?? LAYER_RESOLVERS;
  const activation = [
    resolve.ownEntry(OWN_ENTRIES.cordisHost),
    resolve.packageEntry(CORE_PACKAGE_ENTRIES.config),
    ...distributionPaths,
    ...featurePaths,
  ];
  if (context.preset === OLLAMA_PRESET) activation.push(resolve.ownEntry(OWN_ENTRIES.ollamaProvider));
  if (context.personaEntry) activation.push(context.personaEntry);
  activation.push(resolve.ownEntry(OWN_ENTRIES.cordisFinalizer));
  return deduplicatePaths(activation);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

function compositionFingerprint(composition: Omit<ExtensionComposition, 'fingerprint'>): string {
  return sha256(
    JSON.stringify(
      canonicalValue({
        ...composition,
        contract: {
          composition: COMPOSITION_FINGERPRINT_VERSION,
          standardPiExtension: STANDARD_PI_EXTENSION_CONTRACT_VERSION,
          fixedCorePackages: [...FIXED_CORE_PACKAGES],
        },
        parentCanonicalActivation: composition.parentActivation.map(canonicalModulePath),
        childCanonicalActivation: composition.childActivation.map(canonicalModulePath),
      }),
    ),
  );
}

/** Resolve one deterministic parent/child composition from authored layer occurrences. */
export function resolveExtensionComposition(context: ExtensionContext): ExtensionComposition {
  const resolvers = context.resolvers ?? LAYER_RESOLVERS;
  const defaultSelections = resolveDefaultSelections(context.majorModesConfig, resolvers);
  const layerSelections = resolveSelectedExtensions(context);
  const selections = [...defaultSelections, ...layerSelections];
  const distributionPaths = selectedFeaturePaths(defaultSelections);
  const featurePaths = selectedFeaturePaths(layerSelections);
  const layers = context.layers.map((name, index): CompositionLayerOccurrence => {
    const definition = context.majorModesConfig.layers[name];
    if (!definition) throw new Error(`Unknown layer: ${name}`);
    return {
      name,
      index,
      ...(definition.filePath ? { sourceFile: definition.filePath } : {}),
      baseDirectory: definition.baseDirectory,
    };
  });
  const modeSource = context.majorMode ? context.majorModesConfig.majorModeSources?.[context.majorMode] : undefined;
  const withoutFingerprint: Omit<ExtensionComposition, 'fingerprint'> = {
    version: COMPOSITION_FINGERPRINT_VERSION,
    ...(context.majorMode
      ? {
          majorMode: {
            name: context.majorMode,
            ...(modeSource?.filePath ? { sourceFile: modeSource.filePath } : {}),
            ...(modeSource?.baseDirectory ? { baseDirectory: modeSource.baseDirectory } : {}),
          },
        }
      : {}),
    layers,
    selections,
    parentActivation: parentActivation(context, distributionPaths, featurePaths),
    childActivation: childActivation(context, distributionPaths, featurePaths),
  };
  return { ...withoutFingerprint, fingerprint: compositionFingerprint(withoutFingerprint) };
}

/** Assemble parent entries in actual Pi factory activation order. */
export function assembleExtensions(context: ExtensionContext): string[] {
  return [...resolveExtensionComposition(context).parentActivation];
}

/** Assemble detached-child entries in actual Pi factory activation order. */
export function assembleChildExtensions(context: ExtensionContext): string[] {
  return [...resolveExtensionComposition(context).childActivation];
}
