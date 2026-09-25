import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DOOM_SERVER_BUNDLE_FILE, parseDoomServerBundle } from '../../exports/serverFacet';
import { DOOM_MCP_BUNDLE_FILE, parseDoomMcpBundle } from '../../schemas/mcpBundle';
import { DOOM_PACKAGE_NAME } from '../doomPackage';
import { isRecord, writeFileAtomic } from '../json';
import {
  assertSyncLocationSafe,
  resolveSyncLocation,
  syncGenerationDirectory,
  type SyncIdentity,
  type SyncLocation,
} from '../syncLocation';

/** Current registration schema shared by sync, the managed dispatcher, and runtime consumers. */
export const SYNC_REGISTRATION_VERSION = 2;
/** Legacy schema accepted only with exact producer npm-version validation. */
export const LEGACY_SYNC_REGISTRATION_VERSION = 1;
/** Runtime API contract shared by synchronized generations and DoomPi releases. */
export const DOOMPI_API_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/u;
const PRIVATE_FILE_MODE = 0o600;

export interface SyncPackageRegistration {
  root: string;
  version: string;
  /** Present in registrations written by the API-versioned sync protocol. */
  apiVersion?: number;
  manifestPath: string;
  entry: string;
}

export interface SyncServerBundleRegistration {
  path: string;
  sha256: string;
  fingerprint: string;
}

export type SyncMcpBundleRegistration = SyncServerBundleRegistration;

export interface SyncRegistration {
  version: number;
  root: string;
  identity: SyncIdentity;
  generation: string;
  generationRoot: string;
  statePath: string;
  stateSha256: string;
  webDirectory: string | null;
  apiDirectory: string;
  /** Missing only for explicitly supported pre-cutover generations. */
  serverBundle?: SyncServerBundleRegistration;
  /** Explicit MCP runtime admitted with this generation. */
  mcpBundle?: SyncMcpBundleRegistration;
  package: SyncPackageRegistration;
}

function canonicalPath(target: string): string {
  return fs.realpathSync.native(path.resolve(target));
}

function isInside(directory: string, target: string): boolean {
  const relative = path.relative(canonicalPath(directory), canonicalPath(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requiredString(value: unknown, field: string, recordPath: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Doom sync registration at ${recordPath} has an invalid ${field}`);
  }
  return value;
}

function identityFrom(value: unknown, recordPath: string): SyncIdentity {
  if (!isRecord(value)) throw new Error(`Doom sync registration at ${recordPath} has no identity`);
  return {
    repositoryId: requiredString(value.repositoryId, 'repository id', recordPath),
    worktreeId: requiredString(value.worktreeId, 'worktree id', recordPath),
  };
}

function packageFrom(value: unknown, recordPath: string): SyncPackageRegistration {
  if (!isRecord(value)) throw new Error(`Doom sync registration at ${recordPath} has no package record`);
  return {
    root: requiredString(value.root, 'package root', recordPath),
    version: requiredString(value.version, 'package version', recordPath),
    ...(value.apiVersion === undefined ? {} : { apiVersion: value.apiVersion as number }),
    manifestPath: requiredString(value.manifestPath, 'package manifest', recordPath),
    entry: requiredString(value.entry, 'package entry', recordPath),
  };
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validatePackage(value: SyncPackageRegistration, recordPath: string, recordVersion: number): void {
  const packageRoot = canonicalPath(value.root);
  if (packageRoot !== path.resolve(value.root)) {
    throw new Error(`Doom sync registration at ${recordPath} has a noncanonical package root`);
  }
  if (!isInside(packageRoot, value.manifestPath) || !isInside(packageRoot, value.entry)) {
    throw new Error(`Doom sync registration at ${recordPath} references package material outside ${packageRoot}`);
  }
  if (canonicalPath(value.manifestPath) !== canonicalPath(path.join(packageRoot, 'package.json'))) {
    throw new Error(`Doom sync registration at ${recordPath} has an invalid package manifest path`);
  }
  const manifest = JSON.parse(fs.readFileSync(value.manifestPath, 'utf8')) as {
    name?: unknown;
    version?: unknown;
    doompiApiVersion?: unknown;
    pi?: { extensions?: unknown };
  };
  if (manifest.name !== DOOM_PACKAGE_NAME || typeof manifest.version !== 'string') {
    throw new Error(`Doom sync registration at ${recordPath} does not match its DoomPi package`);
  }
  if (recordVersion === LEGACY_SYNC_REGISTRATION_VERSION && value.apiVersion === undefined) {
    // Registrations written before API compatibility was persisted remain valid
    // only when their exact producer release is still installed.
    if (manifest.version !== value.version) {
      throw new Error(`Doom sync registration at ${recordPath} does not match its DoomPi package`);
    }
  } else {
    if (value.apiVersion === undefined) {
      throw new Error(`Doom sync registration at ${recordPath} has no package API version`);
    }
    if (!Number.isSafeInteger(value.apiVersion) || value.apiVersion < 1) {
      throw new Error(`Doom sync registration at ${recordPath} has an invalid package API version`);
    }
    if (manifest.doompiApiVersion !== value.apiVersion) {
      throw new Error(`Doom sync registration at ${recordPath} has a mismatched package API version`);
    }
    if (value.apiVersion !== DOOMPI_API_VERSION) {
      throw new Error(`Unsupported DoomPi package API version at ${recordPath}`);
    }
  }
  const extensions = manifest.pi?.extensions;
  if (
    !Array.isArray(extensions) ||
    !extensions.some(
      (entry) =>
        typeof entry === 'string' && canonicalPath(path.resolve(packageRoot, entry)) === canonicalPath(value.entry),
    )
  ) {
    throw new Error(`Doom sync registration at ${recordPath} does not match the package Pi entry`);
  }
}

/** Validates one parsed registration against its canonical repository/worktree location. */
export function validateSyncRegistration(registration: SyncRegistration, location: SyncLocation): SyncRegistration {
  const recordPath = location.registrationPath;
  const recordVersion = registration.version;
  if (recordVersion !== SYNC_REGISTRATION_VERSION && recordVersion !== LEGACY_SYNC_REGISTRATION_VERSION) {
    throw new Error(`Unsupported Doom sync registration version at ${recordPath}`);
  }
  const canonicalRoot = canonicalPath(registration.root);
  if (canonicalRoot !== location.root || path.resolve(registration.root) !== canonicalRoot) {
    throw new Error(`Doom sync registration at ${recordPath} has an invalid repository root`);
  }
  if (
    registration.identity.repositoryId !== location.identity.repositoryId ||
    registration.identity.worktreeId !== location.identity.worktreeId
  ) {
    throw new Error(`Doom sync registration at ${recordPath} belongs to another repository or worktree`);
  }
  const expectedGenerationRoot = syncGenerationDirectory(location, registration.generation);
  if (path.resolve(registration.generationRoot) !== path.resolve(expectedGenerationRoot)) {
    throw new Error(`Doom sync registration at ${recordPath} has an invalid generation root`);
  }
  const generationStat = fs.lstatSync(registration.generationRoot, { throwIfNoEntry: false });
  if (!generationStat?.isDirectory() || generationStat.isSymbolicLink()) {
    throw new Error(`Doom sync registration at ${recordPath} has an unavailable generation`);
  }
  for (const target of [registration.statePath, registration.apiDirectory]) {
    if (!isInside(registration.generationRoot, target)) {
      throw new Error(`Doom sync registration at ${recordPath} references material outside its generation`);
    }
  }
  if (registration.webDirectory !== null && !isInside(registration.generationRoot, registration.webDirectory)) {
    throw new Error(`Doom sync registration at ${recordPath} references web material outside its generation`);
  }
  if (!SHA256.test(registration.stateSha256) || sha256File(registration.statePath) !== registration.stateSha256) {
    throw new Error(`Doom sync registration at ${recordPath} has a mismatched state hash`);
  }
  let state: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registration.statePath, 'utf8'));
    if (isRecord(parsed)) state = parsed;
  } catch (error) {
    // Legacy state validation remains the state reader's responsibility. New
    // descriptor generations require their state identity during admission.
    if (registration.serverBundle !== undefined) throw error;
  }
  if (registration.serverBundle !== undefined) {
    const bundle = registration.serverBundle;
    if (
      !isInside(registration.generationRoot, bundle.path) ||
      canonicalPath(bundle.path) !== canonicalPath(path.join(registration.apiDirectory, DOOM_SERVER_BUNDLE_FILE))
    ) {
      throw new Error(`Doom sync registration at ${recordPath} has an invalid server descriptor path`);
    }
    if (!SHA256.test(bundle.sha256) || sha256File(bundle.path) !== bundle.sha256) {
      throw new Error(`Doom sync registration at ${recordPath} has a mismatched server descriptor hash`);
    }
    const descriptor = parseDoomServerBundle(JSON.parse(fs.readFileSync(bundle.path, 'utf8')));
    const recorded = state.serverBundle;
    if (
      descriptor.generation !== registration.generation ||
      descriptor.fingerprint !== bundle.fingerprint ||
      !isRecord(recorded) ||
      recorded.fingerprint !== bundle.fingerprint ||
      recorded.descriptorPath !== bundle.path
    ) {
      throw new Error(`Doom sync registration at ${recordPath} has mismatched server bundle identity`);
    }
  } else if (state.serverBundle !== undefined) {
    throw new Error(`Doom sync registration at ${recordPath} is missing its server bundle record`);
  }
  if (registration.mcpBundle !== undefined) {
    const bundle = registration.mcpBundle;
    if (
      !isInside(registration.generationRoot, bundle.path) ||
      canonicalPath(bundle.path) !== canonicalPath(path.join(registration.generationRoot, 'mcp', DOOM_MCP_BUNDLE_FILE))
    )
      throw new Error(`Doom sync registration at ${recordPath} has an invalid MCP descriptor path`);
    if (!SHA256.test(bundle.sha256) || sha256File(bundle.path) !== bundle.sha256)
      throw new Error(`Doom sync registration at ${recordPath} has a mismatched MCP descriptor hash`);
    const descriptor = parseDoomMcpBundle(JSON.parse(fs.readFileSync(bundle.path, 'utf8')));
    const recorded = state.mcpBundle;
    if (
      descriptor.generation !== registration.generation ||
      descriptor.fingerprint !== bundle.fingerprint ||
      !isRecord(recorded) ||
      recorded.fingerprint !== bundle.fingerprint ||
      recorded.descriptorPath !== bundle.path
    )
      throw new Error(`Doom sync registration at ${recordPath} has mismatched MCP bundle identity`);
    for (const entry of descriptor.entries) {
      const modulePath = path.resolve(path.dirname(bundle.path), entry.module);
      if (!isInside(registration.generationRoot, modulePath) || sha256File(modulePath) !== entry.sha256)
        throw new Error(`Doom sync registration at ${recordPath} has a mismatched MCP artifact hash`);
    }
  } else if (state.mcpBundle !== undefined) {
    throw new Error(`Doom sync registration at ${recordPath} is missing its MCP bundle record`);
  }
  validatePackage(registration.package, recordPath, recordVersion);
  return registration;
}

export function parseSyncRegistration(value: unknown, recordPath: string): SyncRegistration {
  if (!isRecord(value)) throw new Error(`Doom sync registration at ${recordPath} is not an object`);
  return {
    version: value.version as number,
    root: requiredString(value.root, 'repository root', recordPath),
    identity: identityFrom(value.identity, recordPath),
    generation: requiredString(value.generation, 'generation', recordPath),
    generationRoot: requiredString(value.generationRoot, 'generation root', recordPath),
    statePath: requiredString(value.statePath, 'state path', recordPath),
    stateSha256: requiredString(value.stateSha256, 'state hash', recordPath),
    webDirectory: value.webDirectory === null ? null : requiredString(value.webDirectory, 'web directory', recordPath),
    apiDirectory: requiredString(value.apiDirectory, 'API directory', recordPath),
    ...(value.serverBundle === undefined ? {} : { serverBundle: bundleFrom(value.serverBundle, recordPath, 'server') }),
    ...(value.mcpBundle === undefined ? {} : { mcpBundle: bundleFrom(value.mcpBundle, recordPath, 'MCP') }),
    package: packageFrom(value.package, recordPath),
  };
}

function bundleFrom(value: unknown, recordPath: string, kind: 'server' | 'MCP'): SyncServerBundleRegistration {
  if (!isRecord(value)) throw new Error(`Doom sync registration at ${recordPath} has an invalid ${kind} bundle record`);
  return {
    path: requiredString(value.path, 'server descriptor path', recordPath),
    sha256: requiredString(value.sha256, 'server descriptor hash', recordPath),
    fingerprint: requiredString(value.fingerprint, 'server descriptor fingerprint', recordPath),
  };
}

/** Reads only the exact registration for this repository/worktree. */
export function readSyncRegistration(repoRoot: string, homeDirectory?: string): SyncRegistration | undefined {
  const location = resolveSyncLocation(repoRoot, homeDirectory);
  if (!fs.existsSync(location.registrationPath)) return undefined;
  const parsed = parseSyncRegistration(
    JSON.parse(fs.readFileSync(location.registrationPath, 'utf8')),
    location.registrationPath,
  );
  return validateSyncRegistration(parsed, location);
}

/** Atomically activates one fully staged generation for its worktree. */
export function publishSyncRegistration(
  repoRoot: string,
  registration: SyncRegistration,
  homeDirectory?: string,
): string {
  const location = resolveSyncLocation(repoRoot, homeDirectory);
  assertSyncLocationSafe(location);
  validateSyncRegistration(registration, location);
  writeFileAtomic(location.registrationPath, `${JSON.stringify(registration, null, 2)}\n`);
  fs.chmodSync(location.registrationPath, PRIVATE_FILE_MODE);
  return location.registrationPath;
}

export function syncStateSha256(statePath: string): string {
  return sha256File(statePath);
}
