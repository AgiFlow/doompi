import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSyncRegistration } from '@agimon-ai/doompi-core/sync-registration';
import { BUNDLED_PRECOMPILE_STRATEGY, PRECOMPILE_STATE_VERSION } from '@agimon-ai/doompi-core/sync-state-contract';

import { inputsAreFresh, parseInputFingerprint, type InputFingerprint } from '../../../compiler/inputs';
import { resolveDoomConfigurationRoot } from '../../../composition/repository';
import { readSyncState } from '../../../composition/syncState';
import { ownEntry } from '../entryResolution';

const BOOTSTRAP_ENTRY_ENV = 'DOOMPI_BOOTSTRAP_ENTRY';
const SHA256 = /^[a-f0-9]{64}$/u;

interface CompilerManifest {
  output: string;
  artifacts: string[];
  entries: string[];
  inputs: InputFingerprint[];
  artifactInputs?: InputFingerprint[];
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

function parseFingerprints(value: unknown): InputFingerprint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fingerprints = value.map(parseInputFingerprint);
  return fingerprints.some((fingerprint) => fingerprint === undefined)
    ? undefined
    : (fingerprints as InputFingerprint[]);
}

function packagedDoomEntry(): string {
  return process.env[BOOTSTRAP_ENTRY_ENV] || ownEntry('composedPi');
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
      !Array.isArray(parsed.inputs) ||
      (parsed.artifactInputs !== undefined && !Array.isArray(parsed.artifactInputs))
    ) {
      return undefined;
    }
    const inputs = parseFingerprints(parsed.inputs);
    const artifactInputs = parsed.artifactInputs === undefined ? undefined : parseFingerprints(parsed.artifactInputs);
    if (!inputs || (parsed.artifactInputs !== undefined && !artifactInputs)) return undefined;
    const artifacts = parsed.artifacts as string[];
    const entries = parsed.entries as string[];
    if (
      !isInside(generatedDirectory, parsed.output) ||
      artifacts.some((artifact) => !isInside(generatedDirectory, artifact))
    ) {
      return undefined;
    }
    return { output: parsed.output, artifacts, entries, inputs, ...(artifactInputs ? { artifactInputs } : {}) };
  } catch {
    return undefined;
  }
}

function artifactInputsAreIntact(manifest: CompilerManifest, generatedDirectory: string): boolean {
  try {
    if (!manifest.artifactInputs || manifest.artifactInputs.length === 0) return false;
    const expected = new Set([manifest.output, ...manifest.artifacts].map(canonicalPath));
    const seen = new Set<string>();
    for (const input of manifest.artifactInputs) {
      if (!SHA256.test(input.sha256) || !isInside(generatedDirectory, input.path)) return false;
      const target = canonicalPath(input.path);
      if (!expected.has(target)) return false;
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size !== input.size) return false;
      if (crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== input.sha256) return false;
      seen.add(target);
    }
    return seen.size === expected.size;
  } catch {
    return false;
  }
}

function compilerManifestIsUsable(manifest: CompilerManifest, generatedDirectory: string): boolean {
  return artifactInputsAreIntact(manifest, generatedDirectory);
}

function compilerManifestIsFresh(manifest: CompilerManifest, generatedDirectory: string): boolean {
  return compilerManifestIsUsable(manifest, generatedDirectory) && inputsAreFresh(manifest.inputs);
}

function bootstrapRecord(
  state: BootstrapState,
  expectedBootstrapEntry: string,
  requireFreshInputs: boolean,
): CompilerManifest | undefined {
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
    !compilerManifestIsUsable(record, state.generatedDirectory) ||
    (requireFreshInputs && !compilerManifestIsFresh(record, state.generatedDirectory)) ||
    record.output !== state.bootstrap ||
    record.entries.length !== 1 ||
    canonicalPath(record.entries[0] ?? '') !== canonicalPath(expectedBootstrapEntry)
  ) {
    return undefined;
  }
  return record;
}

function usableBootstrapRecord(state: BootstrapState, expectedBootstrapEntry: string): CompilerManifest | undefined {
  return bootstrapRecord(state, expectedBootstrapEntry, false);
}

function freshBootstrapRecord(state: BootstrapState, expectedBootstrapEntry: string): CompilerManifest | undefined {
  return bootstrapRecord(state, expectedBootstrapEntry, true);
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
    fresh: usableBootstrapRecord(state, expected) !== undefined,
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
    fresh: Boolean(
      manifest && manifest.output === bundle && compilerManifestIsUsable(manifest, state.generatedDirectory),
    ),
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
    return Boolean(
      manifest && manifest.output === bundle && compilerManifestIsFresh(manifest, state.generatedDirectory),
    );
  });
  return { bootstrap: state.bootstrap, fresh };
}

/** Reads only the generated bootstrap pointer while retaining state validation. */
export function readBootstrapPointer(repoRoot: string, homeDirectory: string = os.homedir()): string | undefined {
  return readBootstrapState(repoRoot, homeDirectory)?.bootstrap;
}
