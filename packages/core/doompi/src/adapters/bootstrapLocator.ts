import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDoomConfigurationRoot } from './repository/repository.ts';
import { readSyncRegistration } from './syncRegistration.ts';
import { readSyncState } from './syncState.ts';
import { BUNDLED_PRECOMPILE_STRATEGY, PRECOMPILE_STATE_VERSION } from './syncStateContract.ts';

const BOOTSTRAP_ENTRY_ENV = 'DOOMPI_BOOTSTRAP_ENTRY';

/**
 * One recorded build input: the stat pair for speed, the digest for truth.
 *
 * Comparing only `size` and `mtimeMs` makes every rebuild look like a change,
 * including one that restored byte-identical output from a build cache, and a
 * sync triggered that way republishes a generation nobody asked for. Comparing
 * content alone is correct but reads every input on every check, and the
 * cockpit polls this. Recording both lets the stat pair answer the common
 * "nothing was touched" case without opening a file, while the digest stays the
 * authority for anything whose stat moved.
 */
export interface InputFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

/**
 * Verdicts already reached, so a rebuild that rewrote every input without
 * changing it does not re-hash the whole graph on every poll.
 *
 * Keyed by the stats actually found on disk, so it can never answer for a set
 * it did not see. Bounded by the compiler manifests in one composition, which
 * is single digits.
 */
const freshnessVerdicts = new Map<string, boolean>();

function digestOf(filePath: string): string | undefined {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    // Unreadable is indistinguishable from absent here: either way the recorded
    // digest cannot be confirmed, so the caller must treat the build as stale.
    return undefined;
  }
}

/** Records one build input, or undefined when it is not a readable regular file. */
export function fingerprintInput(target: string): InputFingerprint | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    // A path that vanished between discovery and recording is simply not an
    // input; the compiler records the set it could read.
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  const sha256 = digestOf(target);
  if (sha256 === undefined) return undefined;
  return { path: target, size: stat.size, mtimeMs: stat.mtimeMs, sha256 };
}

/** Parses one recorded input, rejecting a record written before digests existed. */
export function parseInputFingerprint(value: unknown): InputFingerprint | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.path !== 'string' ||
    typeof value.size !== 'number' ||
    typeof value.mtimeMs !== 'number' ||
    typeof value.sha256 !== 'string'
  ) {
    return undefined;
  }
  return { path: value.path, size: value.size, mtimeMs: value.mtimeMs, sha256: value.sha256 };
}

/** Whether every recorded input still holds the bytes it was recorded with. */
export function inputsAreFresh(inputs: readonly InputFingerprint[]): boolean {
  const moved: InputFingerprint[] = [];
  const key = crypto.createHash('sha256');
  for (const input of inputs) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(input.path);
    } catch {
      // A recorded input that is gone cannot be confirmed, and no digest will
      // bring it back; the build it describes is stale.
      return false;
    }
    if (!stat.isFile()) return false;
    key.update(`${input.path} ${String(stat.size)} ${String(stat.mtimeMs)} `);
    if (stat.size !== input.size || stat.mtimeMs !== input.mtimeMs) moved.push(input);
  }
  if (moved.length === 0) return true;

  const cacheKey = key.digest('hex');
  const remembered = freshnessVerdicts.get(cacheKey);
  if (remembered !== undefined) return remembered;
  const fresh = moved.every((input) => digestOf(input.path) === input.sha256);
  freshnessVerdicts.set(cacheKey, fresh);
  return fresh;
}

/** Test seam: the memo is process-local and must not leak between cases. */
export function resetInputFreshnessCache(): void {
  freshnessVerdicts.clear();
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
  const configuredEntry = process.env[BOOTSTRAP_ENTRY_ENV];
  if (configuredEntry) return configuredEntry;
  const extension = moduleUrl.endsWith('.ts') ? 'ts' : 'mjs';
  const sourceRoot = path.dirname(path.dirname(fileURLToPath(moduleUrl)));
  return path.join(sourceRoot, 'extensions', 'entries', `doom.${extension}`);
}

function locationHasState(repoRoot: string, homeDirectory: string): boolean {
  return readSyncRegistration(repoRoot, homeDirectory) !== undefined;
}

/** Finds the nearest configured repository with generated Doom sync state. */
export function findSyncedRoot(cwd: string, homeDirectory: string = os.homedir()): string | undefined {
  if (locationHasState(cwd, homeDirectory)) return canonicalPath(cwd);
  const root = resolveDoomConfigurationRoot(cwd, homeDirectory);
  return locationHasState(root, homeDirectory) ? canonicalPath(root) : undefined;
}

function readBootstrapState(repoRoot: string, homeDirectory: string = os.homedir()): BootstrapState | undefined {
  const registration = readSyncRegistration(repoRoot, homeDirectory);
  if (!registration) return undefined;
  const statePath = registration.statePath;
  const generatedDirectory = registration.generationRoot;
  const state = readSyncState(repoRoot, homeDirectory);
  if (!state) return undefined;
  const bootstrap = typeof state.bootstrap === 'string' ? state.bootstrap : undefined;
  if (bootstrap && !isInside(generatedDirectory, bootstrap)) {
    throw new Error(`Doom bootstrap must stay inside ${generatedDirectory}: ${bootstrap}`);
  }

  let precompile: BootstrapState['precompile'];
  if (state.precompile !== undefined) {
    const value = state.precompile;
    if (
      !isRecord(value) ||
      typeof value.version !== 'number' ||
      value.strategy !== BUNDLED_PRECOMPILE_STRATEGY ||
      typeof value.bootstrapEntry !== 'string' ||
      typeof value.bootstrapManifest !== 'string' ||
      !isRecord(value.bundleManifests) ||
      Object.values(value.bundleManifests).some((manifest) => typeof manifest !== 'string')
    ) {
      throw new Error(`Doom sync state at ${statePath} has an invalid precompile record`);
    }
    precompile = {
      version: value.version,
      strategy: value.strategy,
      bootstrapEntry: value.bootstrapEntry,
      bootstrapManifest: value.bootstrapManifest,
      bundleManifests: value.bundleManifests as Record<string, string>,
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
      // A manifest written before digests were recorded cannot be confirmed by
      // content, so it reads as absent and the next sync rewrites it.
      const fingerprint = parseInputFingerprint(input);
      if (fingerprint === undefined) return undefined;
      inputs.push(fingerprint);
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
  return inputsAreFresh(manifest.inputs);
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
  expectedBootstrapEntry?: string,
  homeDirectory: string = os.homedir(),
): BootstrapStatus {
  const state = readBootstrapState(repoRoot, homeDirectory);
  const expected = expectedBootstrapEntry ?? packagedDoomEntry();
  if (!state) return { bootstrap: undefined, fresh: false };
  return {
    bootstrap: state.bootstrap,
    fresh: freshBootstrapRecord(state, expected) !== undefined,
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
  expectedBootstrapEntry?: string,
  homeDirectory: string = os.homedir(),
): BootstrapStatus {
  const state = readBootstrapState(repoRoot, homeDirectory);
  const expected = expectedBootstrapEntry ?? packagedDoomEntry();
  if (!state?.bootstrap || !state.precompile || !freshBootstrapRecord(state, expected)) {
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
