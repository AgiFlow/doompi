import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepositoryRoot } from './repository/repository.ts';
import { resolveSyncLocation } from './syncLocation.ts';
import { readLocatedSyncState } from './syncState.ts';
import { BUNDLED_PRECOMPILE_STRATEGY, PRECOMPILE_STATE_VERSION } from './syncStateContract.ts';

interface InputFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

interface CompilerManifest {
  output: string;
  artifacts: string[];
  entries: string[];
  inputs: InputFingerprint[];
}

interface BootstrapState {
  statePath: string;
  generatedDirectory: string;
  bootstrap?: string;
  bundles: Record<string, string>;
  precompile?: {
    version: number;
    strategy: 'bundle';
    bootstrapEntry: string;
    bootstrapManifest: string;
    bundleManifests: Record<string, string>;
  };
}

export interface BootstrapStatus {
  bootstrap?: string;
  fresh: boolean;
}

export interface BundleStatus {
  bundle?: string;
  fresh: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
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

function packagedDoomEntry(moduleUrl: string = import.meta.url): string {
  const extension = moduleUrl.endsWith('.ts') ? 'ts' : 'mjs';
  const sourceRoot = path.dirname(path.dirname(fileURLToPath(moduleUrl)));
  return path.join(sourceRoot, 'extensions', 'entries', `doom.${extension}`);
}

function locationHasState(repoRoot: string, homeDirectory: string): boolean {
  const location = resolveSyncLocation(repoRoot, homeDirectory);
  return fs.existsSync(location.statePath) || fs.existsSync(location.legacyStatePath);
}

/** Finds the nearest configured repository with generated Doom sync state. */
export function findSyncedRoot(cwd: string, homeDirectory: string = os.homedir()): string | undefined {
  try {
    if (locationHasState(cwd, homeDirectory)) return canonicalPath(cwd);
    const root = findRepositoryRoot(cwd);
    return locationHasState(root, homeDirectory) ? root : undefined;
  } catch {
    return undefined;
  }
}

function readBootstrapState(repoRoot: string, homeDirectory: string = os.homedir()): BootstrapState | undefined {
  const located = readLocatedSyncState(repoRoot, homeDirectory);
  if (!located) return undefined;
  const { state } = located;
  const statePath = located.layout === 'global' ? located.location.statePath : located.location.legacyStatePath;
  const generatedDirectory = path.dirname(statePath);
  const bootstrap = state.bootstrap;
  if (bootstrap && !isInside(generatedDirectory, bootstrap)) {
    throw new Error(`Doom bootstrap must stay inside ${generatedDirectory}: ${bootstrap}`);
  }

  let precompile: BootstrapState['precompile'];
  if (state.precompile !== undefined) {
    if (
      typeof state.precompile.version !== 'number' ||
      state.precompile.strategy !== BUNDLED_PRECOMPILE_STRATEGY ||
      typeof state.precompile.bootstrapEntry !== 'string' ||
      typeof state.precompile.bootstrapManifest !== 'string' ||
      !isRecord(state.precompile.bundleManifests) ||
      Object.values(state.precompile.bundleManifests).some((manifest) => typeof manifest !== 'string')
    ) {
      throw new Error(`Doom sync state at ${statePath} has an invalid precompile record`);
    }
    precompile = {
      version: state.precompile.version,
      strategy: state.precompile.strategy,
      bootstrapEntry: state.precompile.bootstrapEntry,
      bootstrapManifest: state.precompile.bootstrapManifest,
      bundleManifests: state.precompile.bundleManifests as Record<string, string>,
    };
  }

  return {
    statePath,
    generatedDirectory,
    bootstrap,
    bundles: stringRecord(state.bundles),
    precompile,
  };
}

function readCompilerManifest(manifestPath: string, generatedDirectory: string): CompilerManifest | undefined {
  if (!isInside(generatedDirectory, manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.output !== 'string' ||
      !Array.isArray(parsed.artifacts) ||
      parsed.artifacts.some((artifact) => typeof artifact !== 'string') ||
      !Array.isArray(parsed.entries) ||
      parsed.entries.some((entry) => typeof entry !== 'string') ||
      !Array.isArray(parsed.inputs)
    ) {
      return undefined;
    }
    const inputs: InputFingerprint[] = [];
    for (const input of parsed.inputs) {
      if (
        !isRecord(input) ||
        typeof input.path !== 'string' ||
        typeof input.size !== 'number' ||
        typeof input.mtimeMs !== 'number'
      ) {
        return undefined;
      }
      inputs.push({ path: input.path, size: input.size, mtimeMs: input.mtimeMs });
    }
    const artifacts = parsed.artifacts as string[];
    const entries = parsed.entries as string[];
    if (
      !isInside(generatedDirectory, parsed.output) ||
      artifacts.some((artifact) => !isInside(generatedDirectory, artifact))
    ) {
      return undefined;
    }
    return { output: parsed.output, artifacts, entries, inputs };
  } catch {
    return undefined;
  }
}

function compilerManifestIsFresh(manifest: CompilerManifest): boolean {
  if (!fs.existsSync(manifest.output) || manifest.artifacts.some((artifact) => !fs.existsSync(artifact))) return false;
  return manifest.inputs.every((input) => {
    try {
      const stat = fs.statSync(input.path);
      return stat.isFile() && stat.size === input.size && stat.mtimeMs === input.mtimeMs;
    } catch {
      return false;
    }
  });
}

function freshBootstrapRecord(state: BootstrapState, expectedBootstrapEntry: string): CompilerManifest | undefined {
  if (!state.bootstrap || !state.precompile) return undefined;
  if (
    state.precompile.version !== PRECOMPILE_STATE_VERSION ||
    canonicalPath(state.precompile.bootstrapEntry) !== canonicalPath(expectedBootstrapEntry)
  ) {
    return undefined;
  }
  const record = readCompilerManifest(state.precompile.bootstrapManifest, state.generatedDirectory);
  if (
    !record ||
    !compilerManifestIsFresh(record) ||
    record.output !== state.bootstrap ||
    record.entries.length !== 1 ||
    canonicalPath(record.entries[0] ?? '') !== canonicalPath(expectedBootstrapEntry)
  ) {
    return undefined;
  }
  return record;
}

/** Validates only the bootstrap graph needed before the generated bootstrap is imported. */
export function readStartupBootstrapStatus(
  repoRoot: string,
  expectedBootstrapEntry: string = packagedDoomEntry(),
  homeDirectory: string = os.homedir(),
): BootstrapStatus {
  const state = readBootstrapState(repoRoot, homeDirectory);
  if (!state) return { bootstrap: undefined, fresh: false };
  return {
    bootstrap: state.bootstrap,
    fresh: freshBootstrapRecord(state, expectedBootstrapEntry) !== undefined,
  };
}

/** Validates one selected composition without touching any inactive bundle inputs. */
export function readBundleStatus(
  repoRoot: string,
  compositionFingerprint: string,
  homeDirectory: string = os.homedir(),
): BundleStatus {
  const state = readBootstrapState(repoRoot, homeDirectory);
  const bundle = state?.bundles[compositionFingerprint];
  const manifestPath = state?.precompile?.bundleManifests[compositionFingerprint];
  if (!state || state.precompile?.version !== PRECOMPILE_STATE_VERSION || !bundle || !manifestPath) {
    return { bundle, fresh: false };
  }
  const manifest = readCompilerManifest(manifestPath, state.generatedDirectory);
  return {
    bundle,
    fresh: Boolean(manifest && manifest.output === bundle && compilerManifestIsFresh(manifest)),
  };
}

/** Validates the bootstrap and every bundle for `doompi sync --check` diagnostics. */
export function readBootstrapStatus(
  repoRoot: string,
  expectedBootstrapEntry: string = packagedDoomEntry(),
  homeDirectory: string = os.homedir(),
): BootstrapStatus {
  const state = readBootstrapState(repoRoot, homeDirectory);
  if (!state?.bootstrap || !state.precompile || !freshBootstrapRecord(state, expectedBootstrapEntry)) {
    return { bootstrap: state?.bootstrap, fresh: false };
  }
  const manifests = Object.values(state.precompile.bundleManifests);
  if (new Set(manifests).size !== manifests.length) return { bootstrap: state.bootstrap, fresh: false };
  const fresh = Object.entries(state.bundles).every(([fingerprint, bundle]) => {
    const manifestPath = state.precompile?.bundleManifests[fingerprint];
    if (!manifestPath) return false;
    const manifest = readCompilerManifest(manifestPath, state.generatedDirectory);
    return Boolean(manifest && manifest.output === bundle && compilerManifestIsFresh(manifest));
  });
  return { bootstrap: state.bootstrap, fresh };
}

/** Reads only the generated bootstrap pointer while retaining state validation. */
export function readBootstrapPointer(repoRoot: string, homeDirectory: string = os.homedir()): string | undefined {
  return readBootstrapState(repoRoot, homeDirectory)?.bootstrap;
}
