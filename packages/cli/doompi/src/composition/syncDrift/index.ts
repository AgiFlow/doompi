import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseCompiledContracts } from '@agimon-ai/doompi-core/api-contracts';
import { parseDoomMcpBundle } from '@agimon-ai/doompi-core/mcp-facet';
import { parseDoomServerBundle } from '@agimon-ai/doompi-core/server-facet';
import { readSyncRegistration, type SyncRegistration } from '@agimon-ai/doompi-core/sync-registration';

import { readStartupBootstrapStatus, readBootstrapStatus } from '../../builders/cli/bootstrapLocator';
import { inputsAreFresh, parseInputFingerprint } from '../../compiler/inputs';
import { EXTENSION_COMPILER_VERSION } from '../../compiler/version';
import {
  computeInputsHash,
  computeMcpSourcesHash,
  computeServerSourcesHash,
  computeWebSourcesHash,
  readSyncState,
  type SyncState,
} from '../syncState';

export type SyncDriftReason =
  | 'never-synced'
  | 'configuration-changed'
  | 'code-changed'
  | 'runtime-stale'
  | 'cockpit-bundle-missing'
  | 'package-apis-missing'
  | 'server-bundle-stale'
  | 'mcp-bundle-stale';

export interface SyncDrift {
  /** True when nothing needs syncing before a session starts. */
  fresh: boolean;
  reasons: SyncDriftReason[];
  /** The recorded inputs hash, for a caller that wants to log what moved. */
  recordedInputsHash?: string;
  currentInputsHash?: string;
}

export interface ReadSyncDriftOptions {
  repoRoot: string;
  /** Launcher-owned Doom entry used to build this repository's generated bootstrap. */
  expectedBootstrapEntry?: string;
  homeDirectory?: string;
  /** Web hosts cannot reuse a CLI-only generation without plugin artifacts. */
  requireWebBundle?: boolean;
  /** Ignore producer source drift while retaining generation and artifact checks. */
  requireFreshSources?: boolean;
}

function artifactReceiptIsIntact(receipt: Record<string, unknown>, inside: (target: string) => boolean): boolean {
  if (
    receipt.version !== EXTENSION_COMPILER_VERSION ||
    typeof receipt.output !== 'string' ||
    !Array.isArray(receipt.artifacts) ||
    !Array.isArray(receipt.artifactInputs)
  ) {
    return false;
  }
  if (receipt.artifactInputs.length === 0 || receipt.artifacts.some((file) => typeof file !== 'string')) return false;
  const expected = new Set([receipt.output, ...(receipt.artifacts as string[])].map((file) => fs.realpathSync(file)));
  const seen = new Set<string>();
  for (const value of receipt.artifactInputs) {
    const input = parseInputFingerprint(value);
    if (!input || !/^[a-f0-9]{64}$/u.test(input.sha256) || !inside(input.path)) return false;
    const target = fs.realpathSync(input.path);
    if (!expected.has(target)) return false;
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size !== input.size) return false;
    if (crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== input.sha256) return false;
    seen.add(target);
  }
  return seen.size === expected.size;
}

function serverBundleIsUsable(
  state: Pick<SyncState, 'serverBundle' | 'resolved'>,
  registration: Pick<SyncRegistration, 'generation' | 'generationRoot' | 'serverBundle'>,
  requireFreshSources: boolean,
): boolean {
  const bundle = state.serverBundle;
  if (!bundle || !registration.serverBundle) return false;
  try {
    if (requireFreshSources && bundle.sourcesHash !== computeServerSourcesHash(state.resolved)) return false;
    const descriptorPath = fs.realpathSync(bundle.descriptorPath);
    if (descriptorPath !== fs.realpathSync(registration.serverBundle.path)) return false;
    const descriptor = parseDoomServerBundle(JSON.parse(fs.readFileSync(descriptorPath, 'utf8')));
    if (descriptor.generation !== registration.generation || descriptor.fingerprint !== bundle.fingerprint)
      return false;

    const root = fs.realpathSync(registration.generationRoot);
    const inside = (target: string) => {
      const relative = path.relative(root, fs.realpathSync(target));
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    if (!descriptor.contracts) return false;
    const contractFile = path.resolve(path.dirname(descriptorPath), descriptor.contracts.file);
    if (!inside(contractFile)) return false;
    const bytes = fs.readFileSync(contractFile);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== descriptor.contracts.sha256) return false;
    const contracts = parseCompiledContracts(JSON.parse(bytes.toString('utf8')));
    if (contracts.generation !== descriptor.generation || contracts.fingerprint !== descriptor.fingerprint)
      return false;
    const outputs = [
      ...descriptor.entries.map((entry) => ({ key: entry.packageName, module: entry.module })),
      ...contracts.packages.flatMap((entry) =>
        entry.module ? [{ key: `${entry.packageName}#contracts`, module: entry.module }] : [],
      ),
    ];
    if (Object.keys(bundle.compilerManifests).length !== outputs.length) return false;
    for (const entry of outputs) {
      const manifestPath = bundle.compilerManifests[entry.key];
      if (!manifestPath || !inside(manifestPath)) return false;
      const receipt = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      if (
        typeof receipt.output !== 'string' ||
        !inside(receipt.output) ||
        fs.realpathSync(receipt.output) !== fs.realpathSync(path.resolve(path.dirname(descriptorPath), entry.module)) ||
        !Array.isArray(receipt.artifacts) ||
        !receipt.artifacts.every((file) => typeof file === 'string' && inside(file))
      )
        return false;
      const inputs = Array.isArray(receipt.inputs) ? receipt.inputs.map(parseInputFingerprint) : [];
      if (inputs.length === 0 || inputs.some((input) => input === undefined)) return false;
      if (requireFreshSources && !inputsAreFresh(inputs as NonNullable<(typeof inputs)[number]>[])) return false;
      if (!artifactReceiptIsIntact(receipt, inside)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Validate direct-module receipts without importing candidates or loading the compiler. */
export function serverBundleIsFresh(
  state: Pick<SyncState, 'serverBundle' | 'resolved'>,
  registration: Pick<SyncRegistration, 'generation' | 'generationRoot' | 'serverBundle'>,
): boolean {
  return serverBundleIsUsable(state, registration, true);
}

/** Validate generated server artifacts while allowing the producer source to drift. */
export function serverBundleIsRuntimeUsable(
  state: Pick<SyncState, 'serverBundle' | 'resolved'>,
  registration: Pick<SyncRegistration, 'generation' | 'generationRoot' | 'serverBundle'>,
): boolean {
  return serverBundleIsUsable(state, registration, false);
}

function mcpBundleIsUsable(
  state: Pick<SyncState, 'mcpBundle' | 'resolved'>,
  registration: Pick<SyncRegistration, 'generation' | 'generationRoot' | 'mcpBundle'>,
  requireFreshSources: boolean,
): boolean {
  const bundle = state.mcpBundle;
  if (!bundle || !registration.mcpBundle) return false;
  try {
    if (requireFreshSources && bundle.sourcesHash !== computeMcpSourcesHash(state.resolved)) return false;
    const descriptorPath = fs.realpathSync(bundle.descriptorPath);
    if (descriptorPath !== fs.realpathSync(registration.mcpBundle.path)) return false;
    const descriptorBytes = fs.readFileSync(descriptorPath);
    if (crypto.createHash('sha256').update(descriptorBytes).digest('hex') !== registration.mcpBundle.sha256)
      return false;
    const descriptor = parseDoomMcpBundle(JSON.parse(descriptorBytes.toString('utf8')));
    if (
      descriptor.generation !== registration.generation ||
      descriptor.fingerprint !== bundle.fingerprint ||
      descriptor.fingerprint !== registration.mcpBundle.fingerprint
    )
      return false;

    const root = fs.realpathSync(registration.generationRoot);
    const inside = (target: string) => {
      const relative = path.relative(root, fs.realpathSync(target));
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    if (Object.keys(bundle.compilerManifests).length !== descriptor.entries.length) return false;
    for (const entry of descriptor.entries) {
      const manifestPath = bundle.compilerManifests[entry.packageName];
      if (!manifestPath || !inside(manifestPath)) return false;
      const receipt = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      const modulePath = path.resolve(path.dirname(descriptorPath), entry.module);
      if (
        typeof receipt.output !== 'string' ||
        !inside(receipt.output) ||
        fs.realpathSync(receipt.output) !== fs.realpathSync(modulePath) ||
        crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex') !== entry.sha256 ||
        !Array.isArray(receipt.artifacts) ||
        !receipt.artifacts.every((file) => typeof file === 'string' && inside(file))
      )
        return false;
      const inputs = Array.isArray(receipt.inputs) ? receipt.inputs.map(parseInputFingerprint) : [];
      if (inputs.length === 0 || inputs.some((input) => input === undefined)) return false;
      if (requireFreshSources && !inputsAreFresh(inputs as NonNullable<(typeof inputs)[number]>[])) return false;
      if (!artifactReceiptIsIntact(receipt, inside)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Validate MCP source inputs, descriptor identity, and compiler artifact receipts. */
export function mcpBundleIsFresh(
  state: Pick<SyncState, 'mcpBundle' | 'resolved'>,
  registration: Pick<SyncRegistration, 'generation' | 'generationRoot' | 'mcpBundle'>,
): boolean {
  return mcpBundleIsUsable(state, registration, true);
}

/** Validate admitted MCP artifacts while allowing producer sources to drift. */
export function mcpBundleIsRuntimeUsable(
  state: Pick<SyncState, 'mcpBundle' | 'resolved'>,
  registration: Pick<SyncRegistration, 'generation' | 'generationRoot' | 'mcpBundle'>,
): boolean {
  return mcpBundleIsUsable(state, registration, false);
}

/**
 * Whether this repository is synced for the composition it would launch.
 *
 * Sync produces three things a session or the cockpit reads later: the
 * resolved composition, the plugin bundle the browser loads, and the package
 * API routes each host mounts. A session started against any of them stale
 * runs, but quietly wrong: the cockpit shows no plugin surfaces and package
 * APIs answer nothing, with nothing in the log to say why.
 *
 * The hash is the one sync already records. It covers every `.doom` document
 * in both the repository and the home directory, the MCP configuration, the
 * plugin catalogue, and each profile's persona files, so an edit to any of
 * them reads as drift without this having to know what changed.
 */
export function readSyncDrift(options: ReadSyncDriftOptions): SyncDrift {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const requireFreshSources = options.requireFreshSources ?? true;
  const reasons: SyncDriftReason[] = [];

  let state: SyncState | undefined;
  let registration: ReturnType<typeof readSyncRegistration>;
  try {
    registration = readSyncRegistration(options.repoRoot, homeDirectory);
    state = registration ? readSyncState(options.repoRoot, homeDirectory) : undefined;
  } catch {
    // Unreadable or invalid registration is indistinguishable from absent for
    // this purpose: the next session needs a sync before it can be trusted.
    state = undefined;
    registration = undefined;
  }
  if (!state || !registration) return { fresh: false, reasons: ['never-synced'] };

  let currentInputsHash: string | undefined;
  try {
    currentInputsHash = computeInputsHash(options.repoRoot, state.selection, homeDirectory);
  } catch {
    // A malformed document cannot be hashed, and syncing is what reports it.
    reasons.push('configuration-changed');
  }
  if (currentInputsHash !== undefined && currentInputsHash !== state.inputsHash) {
    reasons.push('configuration-changed');
  }
  // Cockpit sources are compiled straight from each package's web/ folder, so a
  // rebuilt plugin surface is a real change that no configuration hash sees. A
  // state recorded before this was tracked has nothing to compare and is left
  // alone rather than being called stale on sight.
  if (
    requireFreshSources &&
    state.webSourcesHash !== undefined &&
    computeWebSourcesHash(state.resolved) !== state.webSourcesHash
  ) {
    reasons.push('code-changed');
  }
  // The same question the `--check` path asks, so the cockpit and the CLI
  // cannot disagree about whether one repository is synced.
  try {
    const bootstrapStatus = requireFreshSources
      ? readBootstrapStatus(options.repoRoot, options.expectedBootstrapEntry, homeDirectory)
      : readStartupBootstrapStatus(options.repoRoot, options.expectedBootstrapEntry, homeDirectory);
    if (!bootstrapStatus.fresh) reasons.push('runtime-stale');
  } catch {
    // An unreadable bootstrap record is exactly as unusable as a stale one, and
    // syncing is what reports the underlying cause.
    reasons.push('runtime-stale');
  }
  if (
    (registration.webDirectory === null && options.requireWebBundle) ||
    (registration.webDirectory !== null &&
      (!fs.existsSync(path.join(registration.webDirectory, 'index.html')) ||
        !fs.existsSync(path.join(path.dirname(registration.webDirectory), 'plugins', 'composition.js')) ||
        !fs.existsSync(path.join(path.dirname(registration.webDirectory), 'plugins', 'manifest.json'))))
  ) {
    reasons.push('cockpit-bundle-missing');
  }
  if (!fs.existsSync(registration.apiDirectory)) reasons.push('package-apis-missing');
  if (
    !(requireFreshSources ? serverBundleIsFresh(state, registration) : serverBundleIsRuntimeUsable(state, registration))
  )
    reasons.push('server-bundle-stale');
  if (!(requireFreshSources ? mcpBundleIsFresh(state, registration) : mcpBundleIsRuntimeUsable(state, registration)))
    reasons.push('mcp-bundle-stale');

  return {
    fresh: reasons.length === 0,
    reasons,
    recordedInputsHash: state.inputsHash,
    ...(currentInputsHash === undefined ? {} : { currentInputsHash }),
  };
}

/** A one-line account of what drifted, for a log the person running the hub reads. */
export function describeSyncDrift(drift: SyncDrift): string {
  if (drift.fresh) return 'the repository is synced';
  const detail: Record<SyncDriftReason, string> = {
    'never-synced': 'it has never been synced',
    'configuration-changed': 'its configuration changed since the last sync',
    'code-changed': 'its cockpit sources changed since the last sync',
    'runtime-stale': 'its precompiled runtime is out of date',
    'cockpit-bundle-missing': 'the cockpit bundle is missing',
    'package-apis-missing': 'the package API routes are missing',
    'server-bundle-stale': 'its server bundle is missing or out of date',
    'mcp-bundle-stale': 'its MCP bundle is missing or out of date',
  };
  return drift.reasons.map((reason) => detail[reason]).join(', ');
}
