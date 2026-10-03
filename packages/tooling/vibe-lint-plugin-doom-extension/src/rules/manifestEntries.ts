import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  defaultPluginId,
  renderCliEntry,
  renderServerEntry,
  renderWebEntry,
  resolveTarget,
  scanExtensions,
} from '@agimon-ai/doompi-build';

const SOURCE_EXTENSION_PATTERN = /\.(?:cts|mts|ts|tsx)$/;
const RUNTIME_EXTENSION_PATTERN = /\.(?:cjs|js|mjs)$/;

export interface DoomPackageManifest {
  name?: string;
  exports?: unknown;
  pi?: { extensions?: unknown };
}

export function projectPath(filePath: string, configRoot: string): string | null {
  const root = path.resolve(configRoot);
  const target = path.resolve(filePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return path.relative(root, target).split(path.sep).join('/');
}

export function readPackageManifest(configRoot: string): DoomPackageManifest | null {
  const manifestPath = path.join(configRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as DoomPackageManifest;
  } catch {
    return null;
  }
}

export function runtimeTargets(value: unknown): string[] {
  if (typeof value === 'string') return RUNTIME_EXTENSION_PATTERN.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(runtimeTargets);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(runtimeTargets);
}

export function runtimeStem(target: string): string | null {
  const normalized = target.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized.startsWith('dist/') || !RUNTIME_EXTENSION_PATTERN.test(normalized)) return null;
  return normalized.slice('dist/'.length).replace(RUNTIME_EXTENSION_PATTERN, '');
}

export function sourceStem(relativePath: string): string | null {
  const normalized = relativePath.replaceAll('\\', '/');
  if (!normalized.startsWith('src/') || !SOURCE_EXTENSION_PATTERN.test(normalized)) return null;
  const sourceRelative = normalized.slice('src/'.length);
  const entryRelative = sourceRelative.startsWith('exports/')
    ? sourceRelative.slice('exports/'.length)
    : sourceRelative;
  return entryRelative.replace(SOURCE_EXTENSION_PATTERN, '');
}

export function piDiscoveryEntryStems(configRoot: string): Set<string> {
  const manifest = readPackageManifest(configRoot);
  if (!manifest) return new Set();
  return new Set(
    runtimeTargets(manifest.pi?.extensions)
      .map(runtimeStem)
      .filter((stem): stem is string => stem !== null),
  );
}

export function hostEntryStems(configRoot: string): Set<string> {
  const manifest = readPackageManifest(configRoot);
  if (!manifest) return new Set();
  const targets = runtimeTargets(manifest.pi?.extensions);
  if (manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)) {
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath === './pi' || subpath.startsWith('./extensions/')) targets.push(...runtimeTargets(target));
    }
  }
  return new Set(targets.map(runtimeStem).filter((stem): stem is string => stem !== null));
}

/** Owned by one rule check, never retained across filesystem changes between checks. */
export type GeneratedEntryCache = Map<
  string,
  {
    packageName: string;
    graph: ReturnType<typeof scanExtensions>;
    sources: Map<string, string | null>;
  } | null
>;

/** Resolve canonical build facades without writing generated output during preflight. */
export function generatedEntrySource(
  configRoot: string,
  entry: string,
  cache: GeneratedEntryCache = new Map(),
): string | null {
  const target =
    entry === 'generated/pi.ts'
      ? 'cli'
      : entry === 'generated/server.ts'
        ? 'server'
        : entry === 'generated/web.ts'
          ? 'web'
          : null;
  if (!target) return null;
  const root = path.resolve(configRoot);
  if (!cache.has(root)) {
    const manifest = readPackageManifest(root);
    cache.set(
      root,
      manifest?.name
        ? { packageName: manifest.name, graph: scanExtensions({ packageDir: root }), sources: new Map() }
        : null,
    );
  }
  const cached = cache.get(root);
  if (!cached) return null;
  if (cached.sources.has(entry)) return cached.sources.get(entry) ?? null;
  const { graph, packageName } = cached;
  const resolution = resolveTarget(graph, target);
  const templateAdmission =
    target === 'cli' &&
    graph.entries.some((item) => item.side === 'frontend' && item.surface === 'template' && item.platform === 'web');
  if (
    !resolution.contributions.length &&
    !resolution.escapeHatches.length &&
    !resolution.roots.length &&
    !templateAdmission
  ) {
    cached.sources.set(entry, null);
    return null;
  }
  const render = target === 'cli' ? renderCliEntry : target === 'server' ? renderServerEntry : renderWebEntry;
  const source = render(resolution, {
    packageName,
    pluginId: defaultPluginId(packageName),
    root: graph.root,
    entryDir: 'generated',
  });
  cached.sources.set(entry, source);
  return source;
}
