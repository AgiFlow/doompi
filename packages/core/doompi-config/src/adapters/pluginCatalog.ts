import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  GitPluginSource,
  PluginCatalog,
  PluginCatalogEntry,
  PluginManifestMetadata,
  PluginSource,
} from '../types/domains.ts';

const AGENT_PLUGIN_SCHEMA_PREFIX = 'https://agent-plugins.org/schemas/';
const CACHE_DIRECTORY = 'plugin-cache';
const PLUGIN_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const LEGACY_PLUGIN_MANIFEST_PATHS = [
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
] as const;

export const MARKETPLACE_MANIFEST_RELATIVE_PATHS = [
  '.agents/plugins/marketplace.json',
  '.agents/plugins/api_marketplace.json',
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
] as const;

export interface PluginCatalogConfigSource {
  filePath: string;
  baseDirectory: string;
  value: unknown;
}

interface MarketplaceLocation {
  manifestPath: string;
  root: string;
}

interface ParsedConfiguredEntry {
  source: PluginSource;
  description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requireString(value: unknown, label: string): string {
  const result = optionalString(value, label);
  if (!result) throw new Error(`${label} must be a non-empty string`);
  return result;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported field "${unexpected[0]}"`);
}

function validatePluginIdSegment(value: string, label: string): void {
  if (!PLUGIN_ID_SEGMENT.test(value)) {
    throw new Error(`${label} must start with an alphanumeric character and contain only alphanumerics, ., _, or -`);
  }
}

function validatePluginId(value: string, label: string): void {
  const segments = value.split('@');
  if (segments.length > 2 || segments.some((segment) => !PLUGIN_ID_SEGMENT.test(segment))) {
    throw new Error(`${label} must be a plugin name or plugin@marketplace identifier`);
  }
}

function normalizeRemoteSubdirectory(value: unknown, label: string): string | undefined {
  const raw = optionalString(value, label);
  if (!raw) return undefined;
  const normalized = raw.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    normalized.startsWith('/') ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must stay within the remote repository root`);
  }
  return normalized;
}

function normalizeGitUrl(value: unknown, baseDirectory: string, label: string): string {
  const url = requireString(value, label);
  if (/^(?:https?|ssh|file):\/\//.test(url) || /^git@[^:]+:.+/.test(url) || path.isAbsolute(url)) return url;
  if (url.startsWith('./') || url.startsWith('.\\')) {
    const relative = url.replaceAll('\\', '/').slice(2);
    if (!relative || relative.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`${label} must stay within its declaring root`);
    }
    return path.resolve(baseDirectory, relative);
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url)) {
    return `https://github.com/${url.endsWith('.git') ? url : `${url}.git`}`;
  }
  throw new Error(`${label} is not a supported Git URL`);
}

function resolveMarketplaceLocalPath(rawPath: string, marketplace: MarketplaceLocation, label: string): string {
  if (rawPath === '.' || rawPath === './') return marketplace.root;
  const cursorMarketplace = marketplace.manifestPath.endsWith('.cursor-plugin/marketplace.json');
  const relative = rawPath.startsWith('./') ? rawPath.slice(2) : cursorMarketplace ? rawPath : undefined;
  if (!relative) throw new Error(`${label} must start with ./`);
  const normalized = relative.replaceAll('\\', '/');
  if (normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must stay within the marketplace root`);
  }
  return path.resolve(marketplace.root, normalized);
}

function parseSourceObject(
  value: Record<string, unknown>,
  baseDirectory: string,
  label: string,
  marketplace?: MarketplaceLocation,
): PluginSource {
  const sourceType = requireString(value.source, `${label}.source`);
  if (sourceType === 'local') {
    assertOnlyKeys(value, ['source', 'path', 'description'], label);
    const rawPath = requireString(value.path, `${label}.path`);
    return {
      type: 'local',
      path: marketplace
        ? resolveMarketplaceLocalPath(rawPath, marketplace, `${label}.path`)
        : path.resolve(baseDirectory, rawPath),
    };
  }
  if (sourceType === 'url' || sourceType === 'git-subdir') {
    assertOnlyKeys(value, ['source', 'url', 'path', 'ref', 'sha', 'description'], label);
    const remotePath = normalizeRemoteSubdirectory(value.path, `${label}.path`);
    if (sourceType === 'git-subdir' && !remotePath) {
      throw new Error(`${label}.path must be a non-empty string for git-subdir sources`);
    }
    const ref = optionalString(value.ref, `${label}.ref`);
    const sha = optionalString(value.sha, `${label}.sha`);
    return {
      type: 'git',
      url: normalizeGitUrl(value.url, marketplace?.root ?? baseDirectory, `${label}.url`),
      ...(remotePath ? { path: remotePath } : {}),
      ...(ref ? { ref } : {}),
      ...(sha ? { sha } : {}),
    };
  }
  if (sourceType === 'npm') {
    assertOnlyKeys(value, ['source', 'package', 'version', 'registry', 'description'], label);
    const packageName = requireString(value.package, `${label}.package`);
    if (!NPM_PACKAGE_NAME.test(packageName)) throw new Error(`${label}.package must be a valid npm package name`);
    const version = optionalString(value.version, `${label}.version`);
    const registry = optionalString(value.registry, `${label}.registry`);
    return {
      type: 'npm',
      package: packageName,
      ...(version ? { version } : {}),
      ...(registry ? { registry } : {}),
    };
  }
  throw new Error(`${label}.source must be local, url, git-subdir, or npm`);
}

function parsePluginSource(
  value: unknown,
  baseDirectory: string,
  label: string,
  marketplace?: MarketplaceLocation,
): PluginSource {
  if (typeof value === 'string') {
    const rawPath = requireString(value, label);
    return {
      type: 'local',
      path: marketplace
        ? resolveMarketplaceLocalPath(rawPath, marketplace, label)
        : path.resolve(baseDirectory, rawPath),
    };
  }
  return parseSourceObject(requireRecord(value, label), baseDirectory, label, marketplace);
}

function parseConfiguredEntry(value: unknown, baseDirectory: string, label: string): ParsedConfiguredEntry {
  if (typeof value === 'string') return { source: parsePluginSource(value, baseDirectory, label) };
  const record = requireRecord(value, label);
  const description = optionalString(record.description, `${label}.description`);
  if (record.source === undefined && typeof record.path === 'string') {
    assertOnlyKeys(record, ['path', 'description'], label);
    return {
      source: { type: 'local', path: path.resolve(baseDirectory, requireString(record.path, `${label}.path`)) },
      ...(description ? { description } : {}),
    };
  }
  if (typeof record.source === 'string' && !['local', 'url', 'git-subdir', 'npm'].includes(record.source)) {
    assertOnlyKeys(record, ['source', 'description'], label);
    return {
      source: parsePluginSource(record.source, baseDirectory, `${label}.source`),
      ...(description ? { description } : {}),
    };
  }
  if (isRecord(record.source)) {
    assertOnlyKeys(record, ['source', 'description'], label);
    return {
      source: parsePluginSource(record.source, baseDirectory, `${label}.source`),
      ...(description ? { description } : {}),
    };
  }
  return {
    source: parseSourceObject(record, baseDirectory, label),
    ...(description ? { description } : {}),
  };
}

function marketplaceRootFromManifest(manifestPath: string): string | undefined {
  const normalized = path.resolve(manifestPath);
  for (const relativePath of MARKETPLACE_MANIFEST_RELATIVE_PATHS) {
    const suffix = path.normalize(relativePath);
    if (!normalized.endsWith(suffix)) continue;
    let root = normalized;
    for (const _segment of relativePath.split('/')) root = path.dirname(root);
    return root;
  }
  return undefined;
}

function findMarketplace(rootOrManifest: string): MarketplaceLocation | undefined {
  if (fs.existsSync(rootOrManifest) && fs.statSync(rootOrManifest).isFile()) {
    const root = marketplaceRootFromManifest(rootOrManifest);
    return root ? { manifestPath: path.resolve(rootOrManifest), root } : undefined;
  }
  for (const relativePath of MARKETPLACE_MANIFEST_RELATIVE_PATHS) {
    const manifestPath = path.join(rootOrManifest, relativePath);
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
      return { manifestPath: path.resolve(manifestPath), root: path.resolve(rootOrManifest) };
    }
  }
  return undefined;
}

function readJsonRecord(filePath: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `${label} at ${filePath} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return requireRecord(parsed, `${label} at ${filePath}`);
}

/** Matches Codex manifest precedence, including schema-gated root plugin.json. */
export function findPluginManifestPath(pluginRoot: string): string | undefined {
  const rootManifest = path.join(pluginRoot, 'plugin.json');
  try {
    const metadata = fs.lstatSync(rootManifest);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return undefined;
    const parsed = JSON.parse(fs.readFileSync(rootManifest, 'utf8')) as unknown;
    const schema = isRecord(parsed) && typeof parsed.$schema === 'string' ? parsed.$schema : undefined;
    if (schema?.startsWith(AGENT_PLUGIN_SCHEMA_PREFIX)) return rootManifest;
  } catch {
    // A missing, unreadable, or unrelated root manifest does not outrank legacy manifests.
  }
  return LEGACY_PLUGIN_MANIFEST_PATHS.map((relativePath) => path.join(pluginRoot, relativePath)).find(
    (manifestPath) => fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile(),
  );
}

function readPluginManifestMetadata(pluginRoot: string, diagnostics: string[]): PluginManifestMetadata | undefined {
  const manifestPath = findPluginManifestPath(pluginRoot);
  if (!manifestPath) return undefined;
  try {
    const manifest = readJsonRecord(manifestPath, 'Plugin manifest');
    const schema = optionalString(manifest.$schema, `${manifestPath}.$schema`);
    const name = optionalString(manifest.name, `${manifestPath}.name`);
    const version = optionalString(manifest.version, `${manifestPath}.version`);
    const description = optionalString(manifest.description, `${manifestPath}.description`);
    return {
      path: manifestPath,
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
      ...(schema?.startsWith(AGENT_PLUGIN_SCHEMA_PREFIX) ? { agentPluginSchema: schema } : {}),
    };
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
    return { path: manifestPath };
  }
}

function discoverPluginRoot(
  pluginRoot: string,
  entries: Record<string, PluginCatalogEntry>,
  diagnostics: string[],
): boolean {
  const diagnosticCount = diagnostics.length;
  const manifest = readPluginManifestMetadata(pluginRoot, diagnostics);
  if (!manifest || diagnostics.length !== diagnosticCount) return false;
  const name = manifest.name ?? path.basename(pluginRoot);
  try {
    validatePluginIdSegment(name, `Plugin name in ${manifest.path}`);
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
    return false;
  }
  entries[name] = {
    source: { type: 'local', path: pluginRoot },
    ...(manifest.description ? { description: manifest.description } : {}),
    manifest,
  };
  return true;
}

function discoverPluginFolder(
  root: string,
  entries: Record<string, PluginCatalogEntry>,
  diagnostics: string[],
): number {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return 0;
  if (findPluginManifestPath(root)) return discoverPluginRoot(root, entries, diagnostics) ? 1 : 0;

  let discovered = 0;
  const children = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (discoverPluginRoot(path.join(root, child.name), entries, diagnostics)) discovered += 1;
  }
  return discovered;
}

function parseMarketplace(
  marketplace: MarketplaceLocation,
  entries: Record<string, PluginCatalogEntry>,
  diagnostics: string[],
): void {
  const document = readJsonRecord(marketplace.manifestPath, 'Marketplace manifest');
  const marketplaceName = requireString(document.name, `${marketplace.manifestPath}.name`);
  validatePluginIdSegment(marketplaceName, `${marketplace.manifestPath}.name`);
  if (!Array.isArray(document.plugins)) throw new Error(`${marketplace.manifestPath}.plugins must be an array`);
  for (let index = 0; index < document.plugins.length; index += 1) {
    const label = `${marketplace.manifestPath}.plugins[${index}]`;
    try {
      const plugin = requireRecord(document.plugins[index], label);
      const pluginName = requireString(plugin.name, `${label}.name`);
      validatePluginIdSegment(pluginName, `${label}.name`);
      const id = `${pluginName}@${marketplaceName}`;
      if (Object.hasOwn(entries, id)) continue;
      const source = parsePluginSource(plugin.source, marketplace.root, `${label}.source`, marketplace);
      const description = optionalString(plugin.description, `${label}.description`);
      const manifest = source.type === 'local' ? readPluginManifestMetadata(source.path, diagnostics) : undefined;
      const resolvedDescription = description ?? manifest?.description;
      entries[id] = {
        source,
        marketplace: marketplaceName,
        ...(resolvedDescription ? { description: resolvedDescription } : {}),
        ...(manifest ? { manifest } : {}),
      };
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
}

function parseConfiguredRoots(source: PluginCatalogConfigSource): string[] {
  if (source.value === undefined) return [];
  const document = requireRecord(source.value, `plugins in ${source.filePath}`);
  assertOnlyKeys(document, ['roots', 'entries'], `plugins in ${source.filePath}`);
  if (document.roots === undefined) return [];
  if (!Array.isArray(document.roots)) throw new Error(`plugins.roots in ${source.filePath} must be an array`);
  return document.roots.map((root, index) =>
    path.resolve(source.baseDirectory, requireString(root, `plugins.roots[${index}] in ${source.filePath}`)),
  );
}

function applyConfiguredEntries(
  source: PluginCatalogConfigSource,
  entries: Record<string, PluginCatalogEntry>,
  diagnostics: string[],
): void {
  if (source.value === undefined) return;
  const document = requireRecord(source.value, `plugins in ${source.filePath}`);
  if (document.entries === undefined) return;
  const configuredEntries = requireRecord(document.entries, `plugins.entries in ${source.filePath}`);
  for (const [name, value] of Object.entries(configuredEntries)) {
    validatePluginId(name, `Plugin entry "${name}" in ${source.filePath}`);
    const parsed = parseConfiguredEntry(value, source.baseDirectory, `plugins.entries.${name} in ${source.filePath}`);
    const manifest =
      parsed.source.type === 'local' ? readPluginManifestMetadata(parsed.source.path, diagnostics) : undefined;
    const description = parsed.description ?? manifest?.description;
    entries[name] = {
      source: parsed.source,
      ...(description ? { description } : {}),
      ...(manifest ? { manifest } : {}),
    };
  }
}

export function pluginDirectoryForSource(source: PluginSource, homeDoomDirectory: string): string {
  if (source.type === 'local') return source.path;
  const identity =
    source.type === 'git'
      ? ['git', source.url, source.path ?? '', source.ref ?? '', source.sha ?? '']
      : ['npm', source.package, source.version ?? '', source.registry ?? ''];
  const digest = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return path.join(homeDoomDirectory, CACHE_DIRECTORY, digest);
}

export function loadPluginCatalog(
  sources: readonly PluginCatalogConfigSource[],
  repoRoot: string,
  homeDirectory: string,
): PluginCatalog {
  const diagnostics: string[] = [];
  const entries: Record<string, PluginCatalogEntry> = {};
  const roots = [...new Set(sources.flatMap(parseConfiguredRoots))];
  const candidates = [homeDirectory, repoRoot, ...roots];
  const marketplaces: string[] = [];
  const seenMarketplaces = new Set<string>();

  for (const candidate of candidates) {
    const marketplace = findMarketplace(candidate);
    if (!marketplace) continue;
    if (seenMarketplaces.has(marketplace.manifestPath)) continue;
    seenMarketplaces.add(marketplace.manifestPath);
    marketplaces.push(marketplace.manifestPath);
    try {
      parseMarketplace(marketplace, entries, diagnostics);
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const root of roots) {
    if (findMarketplace(root)) continue;
    if (discoverPluginFolder(root, entries, diagnostics) === 0) {
      diagnostics.push(`Plugin root contains neither a supported marketplace nor discoverable plugins: ${root}`);
    }
  }

  for (const source of sources) applyConfiguredEntries(source, entries, diagnostics);
  return { roots, marketplaces, entries, diagnostics };
}

export function isRemotePluginSource(
  source: PluginSource,
): source is GitPluginSource | Extract<PluginSource, { type: 'npm' }> {
  return source.type !== 'local';
}
