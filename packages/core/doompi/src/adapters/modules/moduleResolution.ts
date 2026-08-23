import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';

const PACKAGE_MANIFEST = 'package.json';
const NODE_MODULES = 'node_modules';
const PI_MANAGED_NPM_DIRECTORY = path.join('.pi', 'npm', NODE_MODULES);
const CURRENT_DIRECTORY_PREFIX = './';
const MANIFEST_PATTERN_PREFIXES = ['!', '+', '-'] as const;
const GLOB_CHARACTERS = /[*?[\]{}()]/;
const EXTENSION_INDEX_NAMES = ['index.ts', 'index.js', 'index.mts', 'index.mjs', 'index.cts', 'index.cjs'] as const;
const EXTENSION_FILE_SUFFIXES = new Set(['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs']);
/** Import-side conditions, in the order Node prefers them for an ESM consumer. */
const IMPORT_CONDITIONS = ['import', 'module', 'node', 'default'] as const;

interface PackageManifest {
  name?: unknown;
  exports?: unknown;
  module?: unknown;
  main?: unknown;
  pi?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPackageManifest(packageRoot: string): PackageManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(packageRoot, PACKAGE_MANIFEST), 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // An unreadable manifest is equivalent to an absent package declaration;
    // the normal export resolver remains available as the compatibility path.
    return undefined;
  }
}

function manifestDeclaresExtensions(manifest: PackageManifest | undefined): boolean {
  return Boolean(manifest && isRecord(manifest.pi) && Object.hasOwn(manifest.pi, 'extensions'));
}

function isManifestPattern(entry: string): boolean {
  return MANIFEST_PATTERN_PREFIXES.some((prefix) => entry.startsWith(prefix));
}

function normalizedRelativePath(packageRoot: string, target: string): string {
  return path.relative(packageRoot, target).split(path.sep).join('/');
}

function matchesManifestPattern(target: string, pattern: string, packageRoot: string): boolean {
  const normalizedPattern = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  const relative = normalizedRelativePath(packageRoot, target);
  return (
    minimatch(relative, normalizedPattern) ||
    minimatch(path.basename(target), normalizedPattern) ||
    minimatch(target.split(path.sep).join('/'), normalizedPattern)
  );
}

function matchesExactManifestPath(target: string, pattern: string, packageRoot: string): boolean {
  const normalizedPattern = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  return (
    normalizedRelativePath(packageRoot, target) === normalizedPattern ||
    target.split(path.sep).join('/') === normalizedPattern
  );
}

function extensionIndexEntry(directory: string): string | undefined {
  for (const indexName of EXTENSION_INDEX_NAMES) {
    const candidate = path.join(directory, indexName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function extensionFilesAt(target: string): string[] {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(target);
  } catch {
    return [];
  }
  if (stats.isFile()) return [target];
  if (!stats.isDirectory()) return [];

  const files: string[] = [];
  for (const entry of fs
    .readdirSync(target, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(target, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && EXTENSION_FILE_SUFFIXES.has(path.extname(entry.name))) {
      files.push(entryPath);
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const indexEntry = extensionIndexEntry(entryPath);
    if (indexEntry) files.push(indexEntry);
  }
  return files;
}

/** Resolves the standard package.json pi.extensions declaration exactly as a layer contribution. */
function manifestExtensionEntries(
  packageRoot: string,
  manifest: PackageManifest | undefined,
  packageName: string,
): string[] | undefined {
  if (!manifestDeclaresExtensions(manifest) || !isRecord(manifest?.pi)) return undefined;
  const configured = manifest.pi.extensions;
  if (!Array.isArray(configured) || !configured.every((entry) => typeof entry === 'string')) {
    throw new Error(`${packageName} package.json pi.extensions must be an array of strings.`);
  }

  const allPaths: string[] = [];
  for (const configuredEntry of configured.filter((entry) => !isManifestPattern(entry))) {
    const candidates = GLOB_CHARACTERS.test(configuredEntry)
      ? fs.globSync(configuredEntry, { cwd: packageRoot }).sort()
      : [configuredEntry];
    for (const candidate of candidates) {
      for (const target of extensionFilesAt(path.resolve(packageRoot, candidate))) {
        if (!allPaths.includes(target)) allPaths.push(target);
      }
    }
  }

  const excluded = configured.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1));
  const forceIncluded = configured.filter((entry) => entry.startsWith('+')).map((entry) => entry.slice(1));
  const forceExcluded = configured.filter((entry) => entry.startsWith('-')).map((entry) => entry.slice(1));
  const selected = allPaths.filter(
    (target) => !excluded.some((pattern) => matchesManifestPattern(target, pattern, packageRoot)),
  );
  for (const target of allPaths) {
    if (
      !selected.includes(target) &&
      forceIncluded.some((pattern) => matchesExactManifestPath(target, pattern, packageRoot))
    ) {
      selected.push(target);
    }
  }
  const filtered = selected.filter(
    (target) => !forceExcluded.some((pattern) => matchesExactManifestPath(target, pattern, packageRoot)),
  );
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Resolves the on-disk entry point of an installed package.
 *
 * Pi loads extensions by absolute path, so anything contributed as an
 * extension has to be resolved to a file before it can be passed along.
 */
export function packageEntry(name: string): string {
  return fileURLToPath(import.meta.resolve(name));
}

/** Same as packageEntry, but returns undefined when the package is absent. */
export function optionalPackageEntry(name: string): string | undefined {
  try {
    return packageEntry(name);
  } catch {
    return undefined;
  }
}

/**
 * Splits `@scope/name/sub/path` into the package name and its export subpath.
 *
 * A scoped name owns two segments, an unscoped name one. Everything after that
 * is the subpath the package's own `exports` map has to answer for.
 */
export function splitPackageSpecifier(specifier: string): { name: string; subpath: string } {
  const segments = specifier.split('/');
  const nameSegments = specifier.startsWith('@') ? 2 : 1;
  const name = segments.slice(0, nameSegments).join('/');
  const rest = segments.slice(nameSegments).join('/');
  return { name, subpath: rest ? `${CURRENT_DIRECTORY_PREFIX}${rest}` : '.' };
}

/** Picks the import-side target out of one `exports` entry. */
function selectImportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = selectImportTarget(candidate);
      if (target) return target;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const conditions = value as Record<string, unknown>;
  for (const condition of IMPORT_CONDITIONS) {
    if (condition in conditions) {
      const target = selectImportTarget(conditions[condition]);
      if (target) return target;
    }
  }
  return undefined;
}

/**
 * Finds an installed package directory by walking the consumer's module chain.
 *
 * Node's own lookup order, so a workspace link in the repository root is found
 * exactly where the repository installed it, and nothing outside that chain can
 * answer for a specifier the repository declared.
 */
function findInstalledPackage(name: string, consumerRoot: string): string | undefined {
  let directory = path.resolve(consumerRoot);
  while (true) {
    const candidate = path.join(directory, NODE_MODULES, name);
    if (fs.existsSync(path.join(candidate, PACKAGE_MANIFEST))) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Finds a package provisioned by Pi without mutating the consumer's package manifest. */
function findManagedPackage(name: string, consumerRoot: string): string | undefined {
  const candidate = path.join(path.resolve(consumerRoot), PI_MANAGED_NPM_DIRECTORY, name);
  return fs.existsSync(path.join(candidate, PACKAGE_MANIFEST)) ? candidate : undefined;
}

function findConsumerPackage(name: string, consumerRoot: string): string | undefined {
  return findInstalledPackage(name, consumerRoot) ?? findManagedPackage(name, consumerRoot);
}

/** Resolves every extension declared by a bare package's standard Pi manifest. */
export function packageEntries(specifier: string): string[] {
  const { name, subpath } = splitPackageSpecifier(specifier);
  if (subpath !== '.') return [packageEntry(specifier)];

  const packageRoot = findInstalledPackage(name, path.dirname(fileURLToPath(import.meta.url)));
  if (!packageRoot) throw new Error(`Cannot resolve package ${name}.`);
  const manifest = readPackageManifest(packageRoot);
  if (!manifestDeclaresExtensions(manifest)) {
    throw new Error(`${name} package.json does not declare pi.extensions.`);
  }
  const manifestEntries = manifestExtensionEntries(packageRoot, manifest, name);
  if (!manifestEntries?.length) throw new Error(`${name} package.json pi.extensions resolves no extension files.`);
  return manifestEntries;
}

/** Same as packageEntries, but returns undefined when the package is absent. */
export function optionalPackageEntries(specifier: string): string[] | undefined {
  try {
    return packageEntries(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Resolves manifest entries from the consumer repository's dependency tree.
 *
 * The meta-package cannot resolve what the repository declares: under an
 * isolated node_modules layout Doom Pi only sees its own dependencies. Walking
 * the consumer's module chain lets its package manifest answer first without
 * accidentally falling through to DoomPi's dependency tree.
 */
export function consumerPackageEntries(specifier: string, consumerRoot: string): string[] | undefined {
  const { name, subpath } = splitPackageSpecifier(specifier);
  const packageRoot = findConsumerPackage(name, consumerRoot);
  if (!packageRoot) return undefined;
  if (subpath === '.') {
    const manifest = readPackageManifest(packageRoot);
    if (!manifestDeclaresExtensions(manifest)) return [];
    return manifestExtensionEntries(packageRoot, manifest, name) ?? [];
  }
  const entry = consumerPackageEntry(specifier, consumerRoot);
  return entry ? [entry] : [];
}

/** Resolves one explicit package export or direct package-relative path from the consumer. */
export function consumerPackageEntry(specifier: string, consumerRoot: string): string | undefined {
  const { name, subpath } = splitPackageSpecifier(specifier);
  const packageRoot = findConsumerPackage(name, consumerRoot);
  if (!packageRoot) return undefined;

  const manifestPath = path.join(packageRoot, PACKAGE_MANIFEST);
  // A relative subpath that the package does not export is still loadable by
  // path, which is how layers point at a file inside a package (`.../index.ts`).
  const directTarget = path.join(packageRoot, subpath);
  let manifest: { exports?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { exports?: unknown };
  } catch {
    return subpath === '.' ? extensionIndexEntry(packageRoot) : fs.existsSync(directTarget) ? directTarget : undefined;
  }

  const exports = manifest.exports;
  if (exports !== undefined && exports !== null) {
    const entry =
      typeof exports === 'object' && !Array.isArray(exports)
        ? (exports as Record<string, unknown>)[subpath]
        : subpath === '.'
          ? exports
          : undefined;
    const target = selectImportTarget(entry);
    if (target) {
      const resolved = path.join(packageRoot, target);
      if (fs.existsSync(resolved)) return resolved;
    }
  }

  return subpath === '.' ? extensionIndexEntry(packageRoot) : fs.existsSync(directTarget) ? directTarget : undefined;
}

/** Resolves one exports subpath from a path-style package directory. */
export function localPackageExport(specifier: string, baseDirectory: string, subpath: string): string | undefined {
  const packageRoot = path.resolve(baseDirectory, specifier);
  const manifest = readPackageManifest(packageRoot);
  const exports = manifest?.exports;
  if (exports === undefined || exports === null) return undefined;
  const target = selectImportTarget(isRecord(exports) ? exports[subpath] : undefined);
  if (!target) return undefined;
  const resolved = path.join(packageRoot, target);
  return fs.existsSync(resolved) ? resolved : undefined;
}

/** Manifest fields consulted when a local package declares no `exports`. */
const MAIN_FIELDS = ['module', 'main'] as const;

/**
 * Returns the canonical name of a path-style package directory.
 *
 * A direct file is intentionally anonymous: treating the repository manifest
 * above it as the file's identity would collapse every local extension in that
 * repository. Only a directory with its own named manifest represents a package
 * that can replace another installed version by logical identity.
 */
export function localPackageName(specifier: string, baseDirectory: string): string | undefined {
  const target = path.resolve(baseDirectory, specifier);
  try {
    if (!fs.statSync(target).isDirectory()) return undefined;
    const manifest = JSON.parse(fs.readFileSync(path.join(target, PACKAGE_MANIFEST), 'utf8')) as {
      name?: unknown;
    };
    return typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves Pi extension entries from a local file, extension directory, or package.
 *
 * A file is taken as the extension entry as written. A package directory uses
 * its native `pi.extensions` declaration or legacy root entry. A plain directory
 * follows Pi's extension discovery convention for scripts and child `index`
 * modules. This lets unpublished extensions live in the repository, or beside
 * the global config in `~/.pi/.doom`, and still load in deterministic order.
 */
export function localEntries(specifier: string, baseDirectory: string): string[] | undefined {
  const target = path.resolve(baseDirectory, specifier);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(target);
  } catch {
    return undefined;
  }
  if (stats.isFile()) return [target];
  if (!stats.isDirectory()) return undefined;

  const manifest = readPackageManifest(target);
  const manifestEntries = manifestExtensionEntries(
    target,
    manifest,
    localPackageName(specifier, baseDirectory) ?? target,
  );
  if (manifestEntries !== undefined) return manifestEntries;
  const entry = localEntry(specifier, baseDirectory);
  return entry ? [entry] : extensionFilesAt(target);
}

/**
 * Resolves a local package selection through its standard Pi manifest.
 * Direct files and extension directories remain valid explicit local paths.
 */
export function localPackageEntries(specifier: string, baseDirectory: string): string[] | undefined {
  const target = path.resolve(baseDirectory, specifier);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(target);
  } catch {
    return undefined;
  }
  if (stats.isFile()) return [target];
  if (!stats.isDirectory()) return undefined;

  const manifestPath = path.join(target, PACKAGE_MANIFEST);
  if (!fs.existsSync(manifestPath)) return extensionFilesAt(target);
  const manifest = readPackageManifest(target);
  if (!manifestDeclaresExtensions(manifest)) return [];
  return manifestExtensionEntries(target, manifest, localPackageName(specifier, baseDirectory) ?? target) ?? [];
}

/** Resolves the legacy single entry from a local package's exports, module, or main field. */
export function localEntry(specifier: string, baseDirectory: string): string | undefined {
  const target = path.resolve(baseDirectory, specifier);
  let isDirectory: boolean;
  try {
    const stats = fs.statSync(target);
    if (stats.isFile()) return target;
    isDirectory = stats.isDirectory();
  } catch {
    return undefined;
  }
  if (!isDirectory) return undefined;

  let manifest: { exports?: unknown; module?: unknown; main?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(target, PACKAGE_MANIFEST), 'utf8')) as typeof manifest;
  } catch {
    return undefined;
  }

  const exports = manifest.exports;
  const rootExport =
    typeof exports === 'object' && exports !== null && !Array.isArray(exports)
      ? (exports as Record<string, unknown>)['.']
      : exports;
  const candidates = [selectImportTarget(rootExport)];
  for (const field of MAIN_FIELDS) {
    if (typeof manifest[field] === 'string') candidates.push(manifest[field]);
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.join(target, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return extensionIndexEntry(target);
}

/**
 * Resolves one of this package's own extensions in src/extensions/entries.
 *
 * The file extension differs between running from source (.ts, how the shell
 * launchers invoke this) and running the build output (.mjs), so it is derived
 * from this module's own URL rather than assumed.
 */
export function ownEntry(name: string): string {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'mjs';
  // This file sits in src/adapters/modules, so the source root is two directories up.
  const sourceRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  return path.join(sourceRoot, 'extensions', 'entries', `${name}.${extension}`);
}

/** Path to Pi's own CLI, which the launch command spawns. */
export function piCliPath(): string {
  return path.join(path.dirname(packageEntry('@earendil-works/pi-coding-agent')), 'cli.js');
}
