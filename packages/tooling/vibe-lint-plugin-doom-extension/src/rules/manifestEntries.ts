import * as fs from 'node:fs';
import * as path from 'node:path';

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
