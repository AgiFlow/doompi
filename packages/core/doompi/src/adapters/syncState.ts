import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDomains, resolvePluginEntries } from '@agimon-ai/doompi-config/domains';
import type { LayerResolvers, MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { loadProfiles, PERSONA_FILES } from '@agimon-ai/doompi-config/profiles';
import type { HarnessState } from '@agimon-ai/doompi-config/types';
import { isDoomMcpProjection, type DoomMcpProjection } from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import {
  assembleChildExtensions,
  assembleExtensions,
  type ExtensionLayerResolvers,
  LAYER_RESOLVERS,
  OLLAMA_PRESET,
  PERSONA_ENTRY,
} from '../services/extensionAssembler.ts';
import { isRecord } from './serialization/json';
import type { JsonObject } from './serialization/json';
import { assertSyncLocationSafe, resolveSyncLocation, type SyncIdentity, type SyncLocation } from './syncLocation.ts';
import { readSyncRegistration } from './syncRegistration.ts';
import { PRECOMPILE_STATE_VERSION, SYNC_STATE_VERSION } from './syncStateContract.ts';

export { SYNC_STATE_VERSION } from './syncStateContract.ts';

/**
 * The file `doom-pi sync` writes and the doom-pi Pi extension reads back.
 *
 * This is the whole contract between the two halves of the synced path. Sync
 * runs in plain Node, where module resolution and the repository config are
 * available; the extension runs inside a Pi session, where neither can be
 * relied on. Everything the extension needs is therefore resolved once here,
 * and everything in this file has to survive JSON.
 */

const PI_DIRECTORY = '.pi';
/** The `.doom` config directory name, under both the repo root and `~/.pi`. */
const DOOM_CONFIG_DIRECTORY = '.doom';
const RUN_DIRECTORY = 'run';
const DEFAULT_PRESET = 'default';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const OWN_PREFIX = 'own:';
const PACKAGE_PREFIX = 'pkg:';
const LOCAL_PREFIX = 'local:';
const LOCAL_PACKAGE_NAME_PREFIX = 'local-package-name:';
const ENTRY_INDEX_SEPARATOR = ':entry:';
const COMPOSITION_FINGERPRINT = /^[a-f0-9]{64}$/u;
const PLUGIN_MCP_CONFIG_FILES = ['.mcp.json', 'mcp.json'] as const;

/** Config that feeds a sync, in the order the hash reads it. */
const HASHED_CONFIG_FILES = ['config.yaml', 'modes.yaml', 'domains.yaml', 'profiles.yaml', 'hooks.yaml'] as const;

export interface SyncSelection {
  majorMode: string;
  domains: string[];
  profile?: string;
  preset: string;
}

/** Paths to the resources sync staged, before any live switch replaces them. */
export interface SyncBaseline {
  mcpConfigPath?: string;
  personaFile?: string;
  themePath: string;
  themeName: string;
}

export interface SyncPrecompileState {
  /** Version of the lightweight freshness contract used by package startup. */
  version: number;
  strategy: 'bundle';
  /** Package entry the generated bootstrap bundles. */
  bootstrapEntry: string;
  /** Compiler manifest whose output is the graph-bundled package bootstrap. */
  bootstrapManifest: string;
  /** Compiler manifest for each graph-bundled composition. */
  bundleManifests: Record<string, string>;
}

export interface SyncState {
  version: number;
  root: string;
  /** Canonical repository and worktree namespace that owns this state. */
  identity: SyncIdentity;
  /** Hash of the config that produced this state, for the staleness warning. */
  inputsHash: string;
  /** Canonical composition selected when this state was recorded. */
  compositionFingerprint: string;
  selection: SyncSelection;
  /** Harness environment the extension applies when the values are unset. */
  env: Record<string, string>;
  /**
   * State the environment does not carry, so it has to be recorded on its own.
   *
   * Plugin hooks, the profile's environment defaults, and the neutral MCP
   * projection live in the session state file rather than in variables.
   */
  fileState: Pick<HarnessState, 'profileEnvironment' | 'pluginHooks'> & {
    mcpProjection: DoomMcpProjection;
  };
  /** Entry name to absolute path, covering every layer, not just the selected mode's. */
  resolved: Record<string, string>;
  /**
   * The same entries after TypeScript ones were bundled to plain ESM.
   *
   * Kept apart from `resolved` so the staleness check still compares resolution
   * against resolution; a state written before this existed simply has none and
   * falls back to loading the source.
   */
  compiled?: Record<string, string>;
  /** Aggregate entry by canonical composition fingerprint. */
  bundles?: Record<string, string>;
  /** Graph-compiled synced bootstrap dynamically loaded by the package entry. */
  bootstrap?: string;
  /** Inputs used to validate generated artifacts without loading the compiler. */
  precompile?: SyncPrecompileState;
  baseline: SyncBaseline;
}

export function syncDirectory(repoRoot: string, homeDirectory: string = os.homedir()): string {
  return resolveSyncLocation(repoRoot, homeDirectory).directory;
}

export function syncStatePath(repoRoot: string, homeDirectory: string = os.homedir()): string {
  return (
    readSyncRegistration(repoRoot, homeDirectory)?.statePath ?? resolveSyncLocation(repoRoot, homeDirectory).statePath
  );
}

export function legacySyncDirectory(repoRoot: string): string {
  return resolveSyncLocation(repoRoot).legacyDirectory;
}

export function legacySyncStatePath(repoRoot: string): string {
  return resolveSyncLocation(repoRoot).legacyStatePath;
}

function canonicalPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(canonicalPath(parent), path.basename(absolute));
  }
}

function isInside(directory: string, target: string): boolean {
  const relative = path.relative(canonicalPath(directory), canonicalPath(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Whether generated state belongs to the repository that is reading it. */
export function syncStateRootMatches(repoRoot: string, stateRoot: string): boolean {
  return canonicalPath(repoRoot) === canonicalPath(stateRoot);
}

/**
 * Per-process scratch directory for live `/domains` and `/profile` switches.
 *
 * Switching rewrites the MCP config and the persona prompt. Writing those back
 * into the synced directory would both mutate the pinned baseline and let two
 * Pi sessions in one repository overwrite each other, which the launcher avoids
 * by giving every run its own temporary directory.
 */
export function runDirectory(
  repoRoot: string,
  processId: number = process.pid,
  homeDirectory: string = os.homedir(),
): string {
  return path.join(syncDirectory(repoRoot, homeDirectory), RUN_DIRECTORY, String(processId));
}

/**
 * How a Pi project settings file should refer to a generated path.
 *
 * Relative to `.pi` when the target lives in the repository, which keeps the
 * committed settings file identical on every machine. A doom-pi installed
 * outside the repository stays absolute: Pi accepts both, and a relative path
 * climbing out of the project would be neither portable nor readable.
 */
export function settingsRelativePath(repoRoot: string, target: string): string {
  const relative = path.relative(repoRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return target;
  return path.relative(path.join(repoRoot, PI_DIRECTORY), target).split(path.sep).join('/');
}

function readIfPresent(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function updateFramedHash(hash: ReturnType<typeof crypto.createHash>, label: string, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  hash.update(`${String(label.length)}:${label}:${String(bytes.byteLength)}:`);
  hash.update(bytes);
}

/** Hashes path, existence, and bytes without making absent and empty files aliases. */
function updateFileInputHash(hash: ReturnType<typeof crypto.createHash>, filePath: string): void {
  const absolutePath = path.resolve(filePath);
  updateFramedHash(hash, 'path', absolutePath);
  if (!fs.existsSync(absolutePath)) {
    updateFramedHash(hash, 'state', 'missing');
    return;
  }
  updateFramedHash(hash, 'state', 'present');
  updateFramedHash(hash, 'contents', fs.readFileSync(absolutePath));
}

/**
 * Hashes the configuration a sync consumed.
 *
 * Deliberately cheap: the extension recomputes this on every session start, so
 * it reads config, marketplace, local plugin manifests, and profile persona text
 * without downloading plugins or re-resolving packages. A dependency upgrade that
 * moves a package path therefore does not show up here; `doom-pi sync --check`
 * re-resolves and is the check that catches that.
 */
export function computeInputsHash(
  repoRoot: string,
  selection: SyncSelection,
  homeDirectory: string = os.homedir(),
): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ ...selection, domains: [...selection.domains].sort() }));
  // Every .doom document layers the global copy under the repository one, so an
  // edit in either location is a real change.
  for (const directory of [
    path.join(homeDirectory, PI_DIRECTORY, DOOM_CONFIG_DIRECTORY),
    path.join(repoRoot, DOOM_CONFIG_DIRECTORY),
  ]) {
    for (const fileName of HASHED_CONFIG_FILES) hash.update(readIfPresent(path.join(directory, fileName)));
  }
  updateFileInputHash(hash, path.join(repoRoot, '.mcp.json'));

  const catalog = loadDomains(repoRoot, homeDirectory).plugins;
  for (const root of catalog.roots) hash.update(root);
  for (const diagnostic of catalog.diagnostics) hash.update(diagnostic);
  for (const marketplace of catalog.marketplaces) {
    hash.update(marketplace);
    hash.update(readIfPresent(marketplace));
  }
  for (const [name, plugin] of Object.entries(catalog.entries).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(name);
    hash.update(JSON.stringify(plugin.source));
    if (plugin.manifest) {
      hash.update(plugin.manifest.path);
      hash.update(readIfPresent(plugin.manifest.path));
    }
  }

  let selectedPluginDirectories: string[] = [];
  try {
    selectedPluginDirectories = [
      ...new Set(
        resolvePluginEntries(repoRoot, selection.domains, [], homeDirectory)
          .filter((plugin) => plugin.mcp !== false)
          .map((plugin) => path.resolve(plugin.directory)),
      ),
    ].sort();
  } catch {
    // The surrounding .doom inputs already make an invalid or removed domain
    // selection stale. Keep this lightweight check readable for old state
    // instead of turning that expected staleness into a startup exception.
  }
  for (const directory of selectedPluginDirectories) {
    for (const fileName of PLUGIN_MCP_CONFIG_FILES) {
      updateFileInputHash(hash, path.join(directory, fileName));
    }
  }

  for (const profile of loadProfiles(repoRoot, homeDirectory)) {
    hash.update(profile.name);
    hash.update(profile.personaRoot);
    hash.update(profile.persona);
    hash.update(JSON.stringify(profile.env));
    const personaDirectory = path.resolve(profile.personaRoot, profile.persona);
    for (const fileName of PERSONA_FILES) {
      const filePath = path.join(personaDirectory, fileName);
      hash.update(filePath);
      hash.update(readIfPresent(filePath));
    }
  }
  return hash.digest('hex');
}

function stringRecord(value: unknown, field: string, statePath: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`Doom sync state at ${statePath} requires ${field} to be an object`);
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function parsePrecompileState(value: unknown, statePath: string): SyncPrecompileState {
  if (
    !isRecord(value) ||
    value.version !== PRECOMPILE_STATE_VERSION ||
    value.strategy !== 'bundle' ||
    typeof value.bootstrapEntry !== 'string' ||
    typeof value.bootstrapManifest !== 'string' ||
    !isRecord(value.bundleManifests) ||
    Object.entries(value.bundleManifests).some(
      ([fingerprint, manifest]) => !COMPOSITION_FINGERPRINT.test(fingerprint) || typeof manifest !== 'string',
    )
  ) {
    throw new Error(`Doom sync state at ${statePath} has an invalid precompile record`);
  }
  return {
    version: value.version,
    strategy: value.strategy,
    bootstrapEntry: value.bootstrapEntry,
    bootstrapManifest: value.bootstrapManifest,
    bundleManifests: value.bundleManifests as Record<string, string>,
  };
}

function precompileMatchesBundles(
  precompile: SyncPrecompileState,
  bundles: Record<string, string> | undefined,
): boolean {
  const bundleFingerprints = Object.keys(bundles ?? {}).sort();
  const manifestFingerprints = Object.keys(precompile.bundleManifests).sort();
  return (
    bundleFingerprints.length === manifestFingerprints.length &&
    bundleFingerprints.every((fingerprint, index) => fingerprint === manifestFingerprints[index])
  );
}

interface ParseSyncStateOptions {
  repoRoot: string;
  location: SyncLocation;
  legacy: boolean;
}

function identityMatches(left: SyncIdentity, right: SyncIdentity): boolean {
  return left.repositoryId === right.repositoryId && left.worktreeId === right.worktreeId;
}

function parseSyncIdentity(value: unknown, statePath: string): SyncIdentity {
  if (!isRecord(value) || typeof value.repositoryId !== 'string' || typeof value.worktreeId !== 'string') {
    throw new Error(`Doom sync state at ${statePath} requires repository and worktree identity`);
  }
  return { repositoryId: value.repositoryId, worktreeId: value.worktreeId };
}

function parseSyncState(source: string, statePath: string, options: ParseSyncStateOptions): SyncState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Doom sync state at ${statePath} is not valid JSON`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`Doom sync state at ${statePath} must be an object`);
  if (typeof parsed.version !== 'number' || parsed.version !== SYNC_STATE_VERSION) {
    throw new Error(
      `Doom sync state at ${statePath} has version ${String(parsed.version)}, expected ${SYNC_STATE_VERSION}. Run doompi sync.`,
    );
  }
  if (typeof parsed.root !== 'string' || typeof parsed.inputsHash !== 'string') {
    throw new Error(`Doom sync state at ${statePath} requires string root and inputsHash`);
  }
  if (
    typeof parsed.compositionFingerprint !== 'string' ||
    !COMPOSITION_FINGERPRINT.test(parsed.compositionFingerprint)
  ) {
    throw new Error(`Doom sync state at ${statePath} requires a canonical compositionFingerprint`);
  }
  if (parsed.nativeGraphs !== undefined) {
    throw new Error(`Doom sync state at ${statePath} contains removed native graph state. Run doompi sync.`);
  }
  if (!syncStateRootMatches(options.repoRoot, parsed.root)) {
    throw new Error(`Doom sync state at ${statePath} belongs to a different repository: ${parsed.root}`);
  }
  const identity = parseSyncIdentity(parsed.identity, statePath);
  if (!identityMatches(identity, options.location.identity)) {
    throw new Error(`Doom sync state at ${statePath} belongs to a different repository or worktree identity`);
  }
  if (!isRecord(parsed.selection) || typeof parsed.selection.majorMode !== 'string') {
    throw new Error(`Doom sync state at ${statePath} requires a selection with a majorMode`);
  }
  if (!isRecord(parsed.baseline) || typeof parsed.baseline.themePath !== 'string') {
    throw new Error(`Doom sync state at ${statePath} requires a baseline with a themePath`);
  }
  const { majorMode, domains, profile, preset } = parsed.selection;
  const fileState = isRecord(parsed.fileState) ? parsed.fileState : {};
  if (!isDoomMcpProjection(fileState.mcpProjection)) {
    throw new Error(`Doom sync state at ${statePath} requires a valid MCP projection. Run doompi sync.`);
  }
  if (!syncStateRootMatches(parsed.root, fileState.mcpProjection.repoRoot)) {
    throw new Error(`Doom sync state at ${statePath} contains an MCP projection for a different repository`);
  }
  const generatedDirectory = options.legacy ? options.location.legacyDirectory : options.location.directory;
  const compiled = parsed.compiled === undefined ? undefined : stringRecord(parsed.compiled, 'compiled', statePath);
  const bundles = parsed.bundles === undefined ? undefined : stringRecord(parsed.bundles, 'bundles', statePath);
  const precompile = parsed.precompile === undefined ? undefined : parsePrecompileState(parsed.precompile, statePath);
  if (precompile && !precompileMatchesBundles(precompile, bundles)) {
    throw new Error(`Doom sync state at ${statePath} has an invalid precompile record`);
  }
  const bootstrap = typeof parsed.bootstrap === 'string' ? parsed.bootstrap : undefined;
  const generatedPaths = [bootstrap, ...Object.values(compiled ?? {}), ...Object.values(bundles ?? {})].filter(
    (entry): entry is string => entry !== undefined,
  );
  if (generatedPaths.some((entry) => !isInside(generatedDirectory, entry))) {
    throw new Error(`Doom sync state at ${statePath} references generated material outside ${generatedDirectory}`);
  }
  return {
    version: parsed.version,
    root: parsed.root,
    identity,
    inputsHash: parsed.inputsHash,
    compositionFingerprint: parsed.compositionFingerprint,
    selection: {
      majorMode,
      domains: Array.isArray(domains) ? domains.filter((name): name is string => typeof name === 'string') : [],
      profile: typeof profile === 'string' ? profile : undefined,
      preset: typeof preset === 'string' ? preset : DEFAULT_PRESET,
    },
    env: stringRecord(parsed.env, 'env', statePath),
    fileState: {
      profileEnvironment: isRecord(fileState.profileEnvironment)
        ? (fileState.profileEnvironment as Record<string, string>)
        : {},
      pluginHooks: Array.isArray(fileState.pluginHooks) ? (fileState.pluginHooks as HarnessState['pluginHooks']) : [],
      mcpProjection: fileState.mcpProjection,
    },
    resolved: stringRecord(parsed.resolved, 'resolved', statePath),
    compiled,
    bundles,
    bootstrap,
    precompile,
    baseline: parsed.baseline as unknown as SyncBaseline,
  };
}

export interface LocatedSyncState {
  state: SyncState;
  location: SyncLocation;
  layout: 'global';
}

/** Reads only state reached through this repository/worktree's validated registration. */
export function readLocatedSyncState(
  repoRoot: string,
  homeDirectory: string = os.homedir(),
): LocatedSyncState | undefined {
  const location = resolveSyncLocation(repoRoot, homeDirectory);
  const registration = readSyncRegistration(repoRoot, homeDirectory);
  if (!registration) return undefined;
  return {
    state: parseSyncState(fs.readFileSync(registration.statePath, 'utf8'), registration.statePath, {
      repoRoot,
      location,
      legacy: false,
    }),
    location,
    layout: 'global',
  };
}

/** Reads the synced state, or undefined when the repository was never synced. */
export function readSyncState(repoRoot: string, homeDirectory: string = os.homedir()): SyncState | undefined {
  return readLocatedSyncState(repoRoot, homeDirectory)?.state;
}

export function serializeSyncState(state: SyncState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export async function writeSyncState(
  repoRoot: string,
  state: SyncState,
  homeDirectory: string = os.homedir(),
  targetPath?: string,
): Promise<string> {
  const location = resolveSyncLocation(repoRoot, homeDirectory);
  const statePath = targetPath ?? location.statePath;
  if (state.version !== SYNC_STATE_VERSION) {
    throw new Error(`Doom sync state writes require version ${SYNC_STATE_VERSION}`);
  }
  if (!COMPOSITION_FINGERPRINT.test(state.compositionFingerprint)) {
    throw new Error('Doom sync state writes require a canonical composition fingerprint');
  }
  if (!isDoomMcpProjection(state.fileState.mcpProjection)) {
    throw new Error('Doom sync state writes require a valid MCP projection');
  }
  if (!syncStateRootMatches(state.root, state.fileState.mcpProjection.repoRoot)) {
    throw new Error('Refusing to write a Doom sync state whose MCP projection belongs to another repository');
  }
  if (!syncStateRootMatches(repoRoot, state.root) || !identityMatches(state.identity, location.identity)) {
    throw new Error('Refusing to write Doom sync state for a different repository or worktree');
  }
  if (state.precompile) {
    const precompile = parsePrecompileState(state.precompile, statePath);
    if (!precompileMatchesBundles(precompile, state.bundles)) {
      throw new Error(`Doom sync state at ${statePath} has an invalid precompile record`);
    }
  }
  if (!isInside(location.directory, statePath)) {
    throw new Error(`Refusing to write Doom sync state outside ${location.directory}`);
  }
  assertSyncLocationSafe(location);
  await fs.promises.mkdir(path.dirname(statePath), { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, serializeSyncState(state), { mode: PRIVATE_FILE_MODE });
    await fs.promises.rename(temporaryPath, statePath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true });
    throw error;
  }
  return statePath;
}

export function ownKey(name: string): string {
  return `${OWN_PREFIX}${name}`;
}

export function packageKey(specifier: string): string {
  return `${PACKAGE_PREFIX}${specifier}`;
}

export function packageEntryKey(specifier: string, index: number): string {
  return index === 0 ? packageKey(specifier) : `${packageKey(specifier)}${ENTRY_INDEX_SEPARATOR}${index}`;
}

/**
 * Keyed by the absolute target, because the same relative specifier means
 * different files under the repository and the global config directory.
 */
export function localKey(specifier: string, baseDirectory: string): string {
  return `${LOCAL_PREFIX}${path.resolve(baseDirectory, specifier)}`;
}

export function localEntryKey(specifier: string, baseDirectory: string, index: number): string {
  return index === 0
    ? localKey(specifier, baseDirectory)
    : `${localKey(specifier, baseDirectory)}${ENTRY_INDEX_SEPARATOR}${index}`;
}

export function localPackageNameKey(specifier: string, baseDirectory: string): string {
  return `${LOCAL_PACKAGE_NAME_PREFIX}${path.resolve(baseDirectory, specifier)}`;
}

export interface RecordingResolvers extends ExtensionLayerResolvers {
  /** Every name this resolver was asked for, keyed for the state file. */
  readonly resolved: Record<string, string>;
  packageEntries(name: string): string[];
  optionalPackageEntries(name: string): string[] | undefined;
  localEntries(specifier: string, baseDirectory: string): string[] | undefined;
}

/**
 * Resolvers that record what they resolve.
 *
 * Sync composes once with every layer selected and hands the recording to the
 * state file, so the extension never has to resolve a specifier itself.
 */
export function createRecordingResolvers(base: LayerResolvers = LAYER_RESOLVERS): RecordingResolvers {
  const resolved: Record<string, string> = {};
  const extensionBase = base as ExtensionLayerResolvers;
  const recordEntries = (entries: string[], keyFor: (index: number) => string): string[] => {
    entries.forEach((entry, index) => {
      resolved[keyFor(index)] = entry;
    });
    return entries;
  };
  return {
    resolved,
    ownEntry(name) {
      const entry = base.ownEntry(name);
      resolved[ownKey(name)] = entry;
      return entry;
    },
    packageEntry(name) {
      const entry = base.packageEntry(name);
      resolved[packageKey(name)] = entry;
      return entry;
    },
    optionalPackageEntry(name) {
      const entry = base.optionalPackageEntry(name);
      // A miss is recorded by omission, which is what later makes the extension
      // treat it as absent instead of failing the whole composition.
      if (entry) resolved[packageKey(name)] = entry;
      return entry;
    },
    packageEntries(name) {
      const entries = extensionBase.packageEntries?.(name) ?? [base.packageEntry(name)];
      return recordEntries(entries, (index) => packageEntryKey(name, index));
    },
    optionalPackageEntries(name) {
      let entries = extensionBase.optionalPackageEntries?.(name);
      if (entries === undefined) {
        const entry = base.optionalPackageEntry(name);
        entries = entry ? [entry] : undefined;
      }
      return entries ? recordEntries(entries, (index) => packageEntryKey(name, index)) : undefined;
    },
    localEntry(specifier, baseDirectory) {
      const entry = base.localEntry(specifier, baseDirectory);
      if (entry) resolved[localKey(specifier, baseDirectory)] = entry;
      return entry;
    },
    localEntries(specifier, baseDirectory) {
      let entries = extensionBase.localEntries?.(specifier, baseDirectory);
      if (entries === undefined) {
        const entry = base.localEntry(specifier, baseDirectory);
        entries = entry ? [entry] : undefined;
      }
      return entries ? recordEntries(entries, (index) => localEntryKey(specifier, baseDirectory, index)) : undefined;
    },
    localPackageName(specifier, baseDirectory) {
      const name = extensionBase.localPackageName?.(specifier, baseDirectory);
      if (name) resolved[localPackageNameKey(specifier, baseDirectory)] = name;
      return name;
    },
  };
}

/**
 * Resolves every entry any layer could contribute, in one pass.
 *
 * Composing with every layer selected and the widest options is what makes the
 * map complete: a later `/mode` switch inside a Pi session can then pick a
 * different set without resolving anything itself. The persona entry is asked
 * for separately because it remains a fixed host entry rather than a layer.
 */
export function recordResolvedEntries(
  majorModesConfig: MajorModesConfig,
  base: LayerResolvers = LAYER_RESOLVERS,
): Record<string, string> {
  const recording = createRecordingResolvers(base);
  recording.packageEntry(PERSONA_ENTRY);
  assembleExtensions({
    agents: true,
    autoStop: true,
    mute: false,
    // The one preset that contributes an extension of its own.
    preset: OLLAMA_PRESET,
    layers: Object.keys(majorModesConfig.layers),
    majorModesConfig,
    resolvers: recording,
  });
  assembleChildExtensions({
    agents: false,
    autoStop: false,
    mute: true,
    preset: OLLAMA_PRESET,
    layers: Object.keys(majorModesConfig.layers),
    majorModesConfig,
    resolvers: recording,
  });
  return recording.resolved;
}

/** Resolvers backed by a synced map, for composing inside a Pi session. */
export function createMapResolvers(
  resolved: Record<string, string>,
  compiled: Record<string, string> = {},
): ExtensionLayerResolvers {
  // The compiled bundle when this entry has one, the source otherwise.
  const entryFor = (key: string): string | undefined => compiled[key] ?? resolved[key];
  const lookup = (key: string, name: string): string => {
    const entry = entryFor(key);
    if (!entry) throw new Error(`${name} is missing from the doompi sync state. Run doompi sync.`);
    return entry;
  };
  const indexedEntries = (keyFor: (index: number) => string): string[] | undefined => {
    const first = entryFor(keyFor(0));
    if (!first) return undefined;
    const entries = [first];
    for (let index = 1; ; index += 1) {
      const entry = entryFor(keyFor(index));
      if (!entry) break;
      entries.push(entry);
    }
    return entries;
  };
  return {
    ownEntry: (name) => lookup(ownKey(name), name),
    packageEntry: (name) => lookup(packageKey(name), name),
    optionalPackageEntry: (name) => entryFor(packageKey(name)),
    packageEntries: (name) => {
      const entries = indexedEntries((index) => packageEntryKey(name, index));
      if (!entries) throw new Error(`${name} is missing from the doompi sync state. Run doompi sync.`);
      return entries;
    },
    optionalPackageEntries: (name) => indexedEntries((index) => packageEntryKey(name, index)),
    localEntry: (specifier, baseDirectory) => entryFor(localKey(specifier, baseDirectory)),
    localEntries: (specifier, baseDirectory) =>
      indexedEntries((index) => localEntryKey(specifier, baseDirectory, index)),
    localPackageName: (specifier, baseDirectory) => resolved[localPackageNameKey(specifier, baseDirectory)],
  };
}

/** Reads the resolved MCP servers back out of a generated config. */
export function readMcpServerNames(configPath: string): string[] {
  if (!fs.existsSync(configPath)) return [];
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as JsonObject;
  return isRecord(config.mcpServers) ? Object.keys(config.mcpServers) : [];
}
