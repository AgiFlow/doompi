import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBootstrapStatus } from './bootstrapLocator.ts';
import { computeInputsHash, computeWebSourcesHash, readSyncState, type SyncState } from './syncState.ts';
import { readSyncRegistration } from './syncRegistration.ts';

export type SyncDriftReason =
  | 'never-synced'
  | 'configuration-changed'
  | 'code-changed'
  | 'runtime-stale'
  | 'cockpit-bundle-missing'
  | 'package-apis-missing';

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
  if (state.webSourcesHash !== undefined && computeWebSourcesHash(state.resolved) !== state.webSourcesHash) {
    reasons.push('code-changed');
  }
  // The same question the `--check` path asks, so the cockpit and the CLI
  // cannot disagree about whether one repository is synced.
  try {
    if (!readBootstrapStatus(options.repoRoot, options.expectedBootstrapEntry, homeDirectory).fresh) {
      reasons.push('runtime-stale');
    }
  } catch {
    // An unreadable bootstrap record is exactly as unusable as a stale one, and
    // syncing is what reports the underlying cause.
    reasons.push('runtime-stale');
  }
  if (
    registration.webDirectory !== null &&
    (!fs.existsSync(path.join(registration.webDirectory, 'index.html')) ||
      !fs.existsSync(path.join(path.dirname(registration.webDirectory), 'plugins', 'composition.js')) ||
      !fs.existsSync(path.join(path.dirname(registration.webDirectory), 'plugins', 'manifest.json')))
  ) {
    reasons.push('cockpit-bundle-missing');
  }
  if (!fs.existsSync(registration.apiDirectory)) reasons.push('package-apis-missing');

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
  };
  return drift.reasons.map((reason) => detail[reason]).join(', ');
}
