import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { isLocalPackageSpecifier, type MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { DefaultPackageManager, type PackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createLayerResolvers, type ExtensionLayerResolvers } from '../services/extensionAssembler.ts';
import { splitPackageSpecifier } from './modules/moduleResolution.ts';
import { piAgentDirectory } from './piSettings.ts';

const NPM_SOURCE_PREFIX = 'npm:';
const PI_MANAGED_NPM_DIRECTORY = path.join('.pi', 'npm');
const PI_MANAGED_MODULES_DIRECTORY = path.join(PI_MANAGED_NPM_DIRECTORY, 'node_modules');
const PI_MANAGED_PACKAGE_NAME = 'pi-extensions';
const UNPINNED_PACKAGE_RANGE = '*';
const PACKAGE_MANIFEST = 'package.json';
const DEFAULT_NPM_COMMAND = 'npm';
const NPM_CLI_ENV = 'DOOMPI_NPM_CLI';
const PACKAGE_CATALOG_ENV = 'DOOMPI_PACKAGE_CATALOG';
const REGISTRY_TIMEOUT_MS = 20_000;
const PACKAGE_MANAGER_STDERR_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  'const [command, ...args] = process.argv.slice(1);',
  "if (!command) throw new Error('Missing package-manager command');",
  "const child = spawn(command, args, { stdio: ['ignore', 2, 2] });",
  "child.once('error', (error) => { console.error(error.message); process.exit(1); });",
  "child.once('exit', (code) => process.exit(code ?? 1));",
].join('');

const execFileAsync = promisify(execFile);

function overridePackageName(selector: string): string {
  const separatorIndex = selector.indexOf('@', selector.startsWith('@') ? 1 : 0);
  return separatorIndex === -1 ? selector : selector.slice(0, separatorIndex);
}

/**
 * Same-major patches for transitive versions pinned by the current foundation packages.
 * npm only honors overrides from the install root, so published extensions cannot carry
 * these fixes in their own manifests.
 */
export const SAFE_TRANSITIVE_OVERRIDES = {
  '@hono/node-server@2.0.0 - 2.0.9': '^2.0.10',
  '@opentelemetry/core@2.0.0 - 2.7.999': '2.8.0',
  'brace-expansion@5.0.0 - 5.0.8': '^5.0.9',
  'hono@4.0.0 - 4.12.33': '^4.12.34',
  'js-yaml@4.0.0 - 4.3.0': '^4.3.1',
  'js-yaml@5.0.0 - 5.2.1': '^5.2.2',
  'liquidjs@10.0.0 - 10.27.0': '^10.27.1',
  'protobufjs@8.0.0 - 8.7.1': '^8.7.2',
} as const satisfies Readonly<Record<string, string>>;

const SAFE_TRANSITIVE_PACKAGE_NAMES = new Set(Object.keys(SAFE_TRANSITIVE_OVERRIDES).map(overridePackageName));

type LayerPackageManager = Pick<PackageManager, 'install' | 'resolveExtensionSources'>;

export interface EnsureLayerPackagesOptions {
  repoRoot: string;
  config: MajorModesConfig;
  layers: readonly string[];
  environment?: NodeJS.ProcessEnv;
  /**
   * Move every managed package to its newest published version.
   *
   * Launch installs what a selection needs and nothing more, so a session never
   * pays for a registry round trip. Sync is the explicit maintenance command and
   * is the only caller that asks for this.
   */
  refresh?: boolean;
  /** Receives one human-readable line per package decision. */
  onProgress?: (message: string) => void;
}

export interface LayerPackageInstallerDependencies {
  packageManager?: LayerPackageManager;
  resolvers?: ExtensionLayerResolvers;
  /** Registry lookup seam; the default reads the newest version with Pi's npm client. */
  publishedVersion?: (name: string) => Promise<string>;
}

/** One managed package moving from the installed version to the newest published one. */
export interface LayerPackageUpdate {
  name: string;
  from: string;
  to: string;
}

export interface LayerPackageResult {
  /** Sources installed because a configured extension could not be resolved. */
  installed: string[];
  /** Packages this run moved to a newer published version. */
  updated: LayerPackageUpdate[];
  /** Packages left at the installed version because the registry could not be read. */
  unchecked: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function withoutConflictingTransitiveOverrides(value: unknown): Record<string, unknown> {
  const overrides = recordValue(value);
  for (const [selector, replacement] of Object.entries(overrides)) {
    if (SAFE_TRANSITIVE_PACKAGE_NAMES.has(overridePackageName(selector))) {
      delete overrides[selector];
    } else if (isRecord(replacement)) {
      overrides[selector] = withoutConflictingTransitiveOverrides(replacement);
    }
  }
  return overrides;
}

function managedPackageManifestPath(repoRoot: string): string {
  return path.join(repoRoot, PI_MANAGED_NPM_DIRECTORY, PACKAGE_MANIFEST);
}

function configuredPackageSpecifiers(config: MajorModesConfig, layers: readonly string[]): string[] {
  const specifiers = new Set<string>();
  const selectedDefinitions = [
    ...(config.default ? [config.default] : []),
    ...layers.map((layerName) => {
      const layer = config.layers[layerName];
      if (!layer) throw new Error(`Unknown layer: ${layerName}`);
      return layer;
    }),
  ];
  for (const layer of selectedDefinitions) {
    for (const configured of layer.packages ?? []) {
      const specifier = typeof configured === 'string' ? configured : configured.name;
      const optional = typeof configured !== 'string' && configured.optional === true;
      if (!optional && !isLocalPackageSpecifier(specifier)) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function resolvePackageEntries(resolvers: ExtensionLayerResolvers, specifier: string): string[] | undefined {
  const entries = resolvers.optionalPackageEntries?.(specifier);
  if (entries !== undefined) return entries;
  const entry = resolvers.optionalPackageEntry(specifier);
  return entry ? [entry] : undefined;
}

/** Adds the complete package set and patched transitive policy to Pi's managed install root. */
export function ensureManagedPackageManifest(
  repoRoot: string,
  sources: readonly string[],
  targets: ReadonlyMap<string, string> = new Map(),
): boolean {
  const manifestPath = managedPackageManifestPath(repoRoot);
  const current = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : undefined;
  let manifest: Record<string, unknown>;
  if (current === undefined) {
    manifest = { name: PI_MANAGED_PACKAGE_NAME, private: true };
  } else {
    const parsed: unknown = JSON.parse(current);
    if (!isRecord(parsed)) throw new Error(`Pi managed package manifest at ${manifestPath} must be a JSON object.`);
    manifest = parsed;
  }

  const dependencies = recordValue(manifest.dependencies);
  for (const source of sources) {
    const name = packageName(source);
    const target = targets.get(name);
    // An exact target is what makes an update reach the store: npm keeps a
    // locked version whenever the recorded range still admits it, and the range
    // it writes back after an install always admits the version it just wrote.
    if (target !== undefined) dependencies[name] = target;
    else if (!Object.hasOwn(dependencies, name)) dependencies[name] = UNPINNED_PACKAGE_RANGE;
  }
  manifest.dependencies = dependencies;
  // npm gives nested and overlapping consumer rules precedence in cases that can retain
  // vulnerable versions, so DoomPi owns these package-specific selectors recursively.
  manifest.overrides = {
    ...withoutConflictingTransitiveOverrides(manifest.overrides),
    ...SAFE_TRANSITIVE_OVERRIDES,
  };
  const pnpm = recordValue(manifest.pnpm);
  pnpm.overrides = {
    ...withoutConflictingTransitiveOverrides(pnpm.overrides),
    ...SAFE_TRANSITIVE_OVERRIDES,
  };
  manifest.pnpm = pnpm;

  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (serialized === current) return false;
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, serialized, 'utf8');
  return true;
}

/** Finds required npm packages selected by defaults and active layers that DoomPi cannot resolve. */
export function missingLayerPackageSpecifiers(
  config: MajorModesConfig,
  layers: readonly string[],
  resolvers: ExtensionLayerResolvers,
): string[] {
  return configuredPackageSpecifiers(config, layers).filter(
    (specifier) => resolvePackageEntries(resolvers, specifier) === undefined,
  );
}

function packageName(source: string): string {
  const specifier = source.startsWith(NPM_SOURCE_PREFIX) ? source.slice(NPM_SOURCE_PREFIX.length) : source;
  if (specifier.startsWith('@')) {
    const slash = specifier.indexOf('/');
    const version = slash === -1 ? -1 : specifier.indexOf('@', slash);
    return version === -1 ? specifier : specifier.slice(0, version);
  }
  const version = specifier.indexOf('@');
  return version === -1 ? specifier : specifier.slice(0, version);
}

interface PackageCatalogEntry {
  target: string;
  dependencies: readonly string[];
}

type PackageCatalog = ReadonlyMap<string, PackageCatalogEntry>;

function readPackageCatalog(environment: NodeJS.ProcessEnv): PackageCatalog {
  const manifestPath = environment[PACKAGE_CATALOG_ENV]?.trim();
  if (!manifestPath) return new Map();
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.packages)) {
    throw new Error(`Unsupported DoomPi package catalog: ${manifestPath}`);
  }
  const catalog = new Map<string, PackageCatalogEntry>();
  for (const [name, value] of Object.entries(parsed.packages)) {
    if (!isRecord(value) || typeof value.archive !== 'string' || !Array.isArray(value.dependencies)) {
      throw new Error(`Invalid package entry for ${name} in ${manifestPath}`);
    }
    const dependencies = value.dependencies.filter(
      (dependency): dependency is string => typeof dependency === 'string',
    );
    if (dependencies.length !== value.dependencies.length)
      throw new Error(`Invalid dependencies for ${name} in ${manifestPath}`);
    const archive = path.resolve(path.dirname(manifestPath), value.archive);
    if (!fs.existsSync(archive)) throw new Error(`DoomPi package catalog archive is missing: ${archive}`);
    catalog.set(name, { target: `file:${archive}`, dependencies });
  }
  return catalog;
}

function npmSources(
  specifiers: readonly string[],
  catalog: PackageCatalog = new Map(),
  includeCatalogDependencies = false,
): string[] {
  const names = [...new Set(specifiers.map((specifier) => splitPackageSpecifier(specifier).name))];
  if (includeCatalogDependencies) {
    for (let index = 0; index < names.length; index += 1) {
      for (const dependency of catalog.get(names[index]!)?.dependencies ?? []) {
        if (!names.includes(dependency)) names.push(dependency);
      }
    }
  }
  return names.map((name) => {
    const target = catalog.get(name)?.target;
    return `${NPM_SOURCE_PREFIX}${name}${target ? `@${target}` : ''}`;
  });
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Version of a package inside Pi's managed store, absent when sync does not own it. */
function managedPackageVersion(repoRoot: string, name: string): string | undefined {
  const manifestPath = path.join(repoRoot, PI_MANAGED_MODULES_DIRECTORY, name, PACKAGE_MANIFEST);
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    // An unreadable manifest carries the same meaning as an absent one: nothing
    // usable is installed, so the caller treats the package as uninstalled.
    return undefined;
  }
}

export function packageManagerCommandWithStderr(configured: readonly string[] | undefined): string[] {
  const command = configured?.length ? configured : [DEFAULT_NPM_COMMAND];
  return [process.execPath, '--eval', PACKAGE_MANAGER_STDERR_SCRIPT, '--', ...command];
}

export function effectivePackageManagerCommand(
  configured: readonly string[] | undefined,
  environment: NodeJS.ProcessEnv,
): readonly string[] | undefined {
  if (configured?.length) return configured;
  const bundledCli = environment[NPM_CLI_ENV]?.trim();
  return bundledCli ? [process.execPath, bundledCli] : undefined;
}

function configuredPackageManagerCommand(
  settingsManager: Pick<SettingsManager, 'getNpmCommand'>,
  environment: NodeJS.ProcessEnv,
): readonly string[] | undefined {
  return effectivePackageManagerCommand(settingsManager.getNpmCommand(), environment);
}

function createPackageManager(repoRoot: string, environment: NodeJS.ProcessEnv): LayerPackageManager {
  const agentDirectory = piAgentDirectory(environment);
  const settingsManager = SettingsManager.create(repoRoot, agentDirectory, { projectTrusted: true });
  const redirectedSettingsManager = new Proxy(settingsManager, {
    get(target, property, receiver) {
      if (property === 'getNpmCommand') {
        return () => packageManagerCommandWithStderr(configuredPackageManagerCommand(target, environment));
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return new DefaultPackageManager({
    cwd: repoRoot,
    agentDir: agentDirectory,
    settingsManager: redirectedSettingsManager,
  });
}

/** Reads newest published versions with the same client Pi installs them with. */
function createVersionReader(repoRoot: string, environment: NodeJS.ProcessEnv): (name: string) => Promise<string> {
  const settingsManager = SettingsManager.create(repoRoot, piAgentDirectory(environment), { projectTrusted: true });
  const [command, ...args] = configuredPackageManagerCommand(settingsManager, environment) ?? [];
  const client = command ?? DEFAULT_NPM_COMMAND;
  return async (name) => {
    const { stdout } = await execFileAsync(client, [...args, 'view', name, 'version', '--json'], {
      cwd: repoRoot,
      timeout: REGISTRY_TIMEOUT_MS,
      encoding: 'utf8',
    });
    const parsed: unknown = JSON.parse(stdout.trim() || 'null');
    if (typeof parsed !== 'string') throw new Error(`${client} view reported no published version`);
    return parsed;
  };
}

interface CheckedPackage {
  name: string;
  from: string;
  to?: string;
  failure?: string;
}

/**
 * Compares every package sync installed against the registry.
 *
 * Only the managed store is consulted: a package that resolves from the
 * repository's own modules is not sync's to move, and a package that is not
 * installed yet is already covered by the missing-package path.
 */
async function resolveUpdates(
  repoRoot: string,
  sources: readonly string[],
  publishedVersion: (name: string) => Promise<string>,
  onProgress: ((message: string) => void) | undefined,
): Promise<Pick<LayerPackageResult, 'updated' | 'unchecked'>> {
  const managed = sources
    .map((source) => ({ name: packageName(source), from: managedPackageVersion(repoRoot, packageName(source)) }))
    .filter((entry): entry is { name: string; from: string } => entry.from !== undefined);
  const checked: CheckedPackage[] = await Promise.all(
    managed.map(async (entry) => {
      try {
        return { ...entry, to: await publishedVersion(entry.name) };
      } catch (error) {
        return { ...entry, failure: (error instanceof Error ? error.message : String(error)).split('\n')[0] };
      }
    }),
  );

  const updated: LayerPackageUpdate[] = [];
  const unchecked: string[] = [];
  for (const entry of checked) {
    if (entry.to === undefined) {
      unchecked.push(entry.name);
      onProgress?.(`kept ${entry.name} ${entry.from}: ${entry.failure ?? 'no published version'}`);
      continue;
    }
    if (entry.to === entry.from) continue;
    updated.push({ name: entry.name, from: entry.from, to: entry.to });
    onProgress?.(`${entry.name} ${entry.from} -> ${entry.to}`);
  }
  return { updated, unchecked };
}

/** Installs selected layer packages into Pi's project-local `.pi/npm` store and verifies the retry. */
export async function ensureLayerPackages(
  options: EnsureLayerPackagesOptions,
  dependencies: LayerPackageInstallerDependencies = {},
): Promise<LayerPackageResult> {
  const environment = options.environment ?? process.env;
  const resolvers = dependencies.resolvers ?? createLayerResolvers(options.repoRoot);
  const configured = configuredPackageSpecifiers(options.config, options.layers);
  const missing = configured.filter((specifier) => resolvePackageEntries(resolvers, specifier) === undefined);
  const catalog = readPackageCatalog(environment);
  const missingSources = npmSources(missing, catalog);
  const sources = npmSources(configured, catalog, true);
  if (sources.length === 0) return { installed: [], updated: [], unchecked: [] };

  const managedDirectory = path.dirname(managedPackageManifestPath(options.repoRoot));
  if (missing.length === 0 && !fs.existsSync(managedDirectory)) return { installed: [], updated: [], unchecked: [] };

  const registrySources = sources.filter((source) => !catalog.has(packageName(source)));
  const { updated, unchecked } = options.refresh
    ? await resolveUpdates(
        options.repoRoot,
        registrySources,
        dependencies.publishedVersion ?? createVersionReader(options.repoRoot, environment),
        options.onProgress,
      )
    : { updated: [], unchecked: [] };
  const targets = new Map<string, string>();
  for (const source of sources) {
    const name = packageName(source);
    const target = catalog.get(name)?.target;
    if (target) targets.set(name, target);
  }
  for (const update of updated) targets.set(update.name, update.to);
  const manifestChanged = ensureManagedPackageManifest(options.repoRoot, sources, targets);
  if (missing.length === 0 && !manifestChanged) return { installed: [], updated: [], unchecked };

  const packageManager = dependencies.packageManager ?? createPackageManager(options.repoRoot, environment);
  options.onProgress?.(
    `installing ${
      updated.length > 0
        ? pluralize(updated.length, 'update')
        : missing.length > 0
          ? pluralize(missing.length, 'missing package')
          : 'the package manifest'
    }`,
  );
  try {
    if (manifestChanged) {
      // Installing one source reconciles the complete dependency set already written
      // to package.json, avoiding one npm install and audit report per DoomPi package.
      await packageManager.install(sources[0]!, { local: true });
    } else {
      await packageManager.resolveExtensionSources(missingSources, { local: true });
    }
  } catch (error) {
    const attempted = manifestChanged ? sources : missingSources;
    throw new Error(`Failed to reconcile DoomPi layer package(s): ${attempted.join(', ')}`, { cause: error });
  }

  const unresolved = missing.filter((specifier) => !resolvePackageEntries(resolvers, specifier)?.length);
  if (unresolved.length > 0) {
    throw new Error(
      `Installed DoomPi layer package(s) did not expose the configured Pi extension: ${unresolved.join(', ')}`,
    );
  }
  return { installed: missingSources, updated, unchecked };
}
