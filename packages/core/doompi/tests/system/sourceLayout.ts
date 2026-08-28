import fs from 'node:fs';
import path from 'node:path';

export interface PackageManifestForSourceLayout {
  readonly name?: unknown;
  readonly exports?: unknown;
  readonly bin?: unknown;
  readonly pi?: unknown;
}

export interface SourceLayoutOptions {
  readonly packageRoot: string;
  readonly manifest: PackageManifestForSourceLayout;
  readonly tsdownEntrySources: readonly string[];
  readonly privateEntrySources?: readonly string[];
  readonly rmuxExempt?: boolean;
}

export interface SourceLayoutReport {
  readonly issues: readonly string[];
  readonly expectedPublicSources: readonly string[];
  readonly actualExportSources: readonly string[];
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;
const DIST_EXTENSIONS = ['.d.mts', '.d.cts', '.d.ts', '.mjs', '.cjs', '.js'] as const;
const RUNNER_ARTIFACT_PACKAGE_PREFIXES = ['@agimon-ai/doompi-runner-rmux-', '@agimon-ai/doompi-runner-rtk-'] as const;

interface ExportTarget {
  readonly subpath: string;
  readonly target: string;
}

interface CandidateSource {
  readonly target: string;
  readonly candidates: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectTargetStrings(value: unknown, subpath: string, targets: ExportTarget[]): void {
  if (typeof value === 'string') {
    targets.push({ subpath, target: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) collectTargetStrings(item, `${subpath}[${index}]`, targets);
    return;
  }
  if (!isRecord(value)) return;
  for (const nested of Object.values(value)) collectTargetStrings(nested, subpath, targets);
}

function manifestExportTargets(manifest: PackageManifestForSourceLayout): ExportTarget[] {
  if (!isRecord(manifest.exports)) return [];
  const targets: ExportTarget[] = [];
  Object.entries(manifest.exports).forEach(([subpath, value]) => {
    if (subpath === './package.json') return;
    collectTargetStrings(value, subpath, targets);
  });
  return targets;
}

function manifestRuntimeTargets(manifest: PackageManifestForSourceLayout): ExportTarget[] {
  const targets = manifestExportTargets(manifest);
  if (typeof manifest.bin === 'string') targets.push({ subpath: 'bin', target: manifest.bin });
  if (isRecord(manifest.bin)) {
    Object.entries(manifest.bin).forEach(([name, target]) => {
      if (typeof target === 'string') targets.push({ subpath: `bin:${name}`, target });
    });
  }
  if (isRecord(manifest.pi) && Array.isArray(manifest.pi.extensions)) {
    manifest.pi.extensions.forEach((target, index) => {
      if (typeof target === 'string') targets.push({ subpath: `pi.extensions[${index}]`, target });
    });
  }
  return targets;
}

function isDistTarget(target: string): boolean {
  return target.startsWith('./dist/') || target.startsWith('dist/');
}

function targetStem(target: string): string | undefined {
  if (!isDistTarget(target)) return undefined;
  const relative = target.replace(/^\.\//u, '').slice('dist/'.length);
  const extension = DIST_EXTENSIONS.find((candidate) => relative.endsWith(candidate));
  if (!extension) return undefined;
  return relative.slice(0, -extension.length);
}

function sourceCandidatesForTarget(target: string): readonly string[] {
  const stem = targetStem(target);
  if (!stem) return [];
  return SOURCE_EXTENSIONS.map((extension) => `src/exports/${stem}${extension}`);
}

function sourceFilesUnderExports(packageRoot: string): readonly string[] {
  const exportsRoot = path.join(packageRoot, 'src', 'exports');
  if (!fs.existsSync(exportsRoot)) return [];
  const sources: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        sources.push(path.relative(packageRoot, entryPath).split(path.sep).join('/'));
      }
    }
  };
  visit(exportsRoot);
  return sources.sort();
}

function sourceFilesUnderSourceRoot(packageRoot: string): readonly string[] {
  const sourceRoot = path.join(packageRoot, 'src');
  if (!fs.existsSync(sourceRoot)) return [];
  const sources: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        sources.push(path.relative(packageRoot, entryPath).split(path.sep).join('/'));
      }
    }
  };
  visit(sourceRoot);
  return sources.sort();
}

function globToRegExp(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`${expression}$`, 'u');
}

function expandEntrySource(packageRoot: string, source: string): readonly string[] {
  const normalized = normalizeSource(source);
  if (!normalized.includes('*')) return [normalized];
  const pattern = globToRegExp(normalized);
  return sourceFilesUnderSourceRoot(packageRoot).filter((candidate) => pattern.test(candidate));
}

function normalizeSource(source: string): string {
  return source.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function duplicateExportTargets(targets: readonly ExportTarget[]): readonly string[] {
  const subpathsByTarget = new Map<string, Set<string>>();
  for (const { subpath, target } of targets) {
    const subpaths = subpathsByTarget.get(target) ?? new Set<string>();
    subpaths.add(subpath);
    subpathsByTarget.set(target, subpaths);
  }
  return [...subpathsByTarget.entries()]
    .filter(([, subpaths]) => subpaths.size > 1)
    .map(([target]) => target)
    .sort();
}

export function collectTsdownEntrySources(configText: string): readonly string[] {
  const sources = [...configText.matchAll(/['"](src\/[^'"]+\.(?:ts|tsx|mts|cts))['"]/gu)].map((match) => match[1]!);
  return unique(sources);
}

export function verifySourceLayout(options: SourceLayoutOptions): SourceLayoutReport {
  const { packageRoot, manifest, tsdownEntrySources } = options;
  if (
    options.rmuxExempt ||
    RUNNER_ARTIFACT_PACKAGE_PREFIXES.some((prefix) => String(manifest.name).startsWith(prefix))
  ) {
    return { issues: [], expectedPublicSources: [], actualExportSources: sourceFilesUnderExports(packageRoot) };
  }

  const issues: string[] = [];
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) issues.push('package manifest name is required');
  const runtimeTargets = manifestRuntimeTargets(manifest).filter(({ target }) => isDistTarget(target));
  const exportTargets = manifestExportTargets(manifest).filter(({ target }) => isDistTarget(target));
  const duplicateTargets = duplicateExportTargets(exportTargets);
  for (const target of duplicateTargets) issues.push(`runtime target is shared by multiple exports: ${target}`);

  const candidates: CandidateSource[] = runtimeTargets.map(({ target }) => ({
    target,
    candidates: sourceCandidatesForTarget(target),
  }));
  const expectedPublicSources = unique(candidates.flatMap(({ candidates: sourceCandidates }) => sourceCandidates));
  const entrySources = new Set(tsdownEntrySources.flatMap((source) => expandEntrySource(packageRoot, source)));
  const actualExportSources = sourceFilesUnderExports(packageRoot);
  const privateSources = new Set((options.privateEntrySources ?? []).map(normalizeSource));

  for (const { target, candidates: sourceCandidates } of candidates) {
    if (sourceCandidates.length === 0) {
      issues.push(`runtime target has no supported source stem: ${target}`);
      continue;
    }
    const source = sourceCandidates.find((candidate) => fs.existsSync(path.join(packageRoot, candidate)));
    if (!source) {
      issues.push(`runtime target has no source under src/exports: ${target}`);
      continue;
    }
    if (!entrySources.has(source)) issues.push(`public source is missing from tsdown entries: ${source}`);
  }

  for (const source of actualExportSources) {
    if (!expectedPublicSources.includes(source)) issues.push(`orphan source under src/exports: ${source}`);
  }

  tsdownEntrySources.map(normalizeSource).forEach((source) => {
    if (source.startsWith('src/exports/')) return;
    if (!privateSources.has(source)) issues.push(`non-public tsdown entry is not allowlisted: ${source}`);
  });

  for (const source of privateSources) {
    if (!fs.existsSync(path.join(packageRoot, source))) issues.push(`allowlisted private entry is missing: ${source}`);
    if (!entrySources.has(source)) issues.push(`allowlisted private entry is missing from tsdown entries: ${source}`);
  }

  return { issues: unique(issues), expectedPublicSources, actualExportSources };
}
