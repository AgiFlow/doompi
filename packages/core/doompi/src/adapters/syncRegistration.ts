import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DOOM_PACKAGE_NAME } from './doomPackage.ts';
import { isRecord, writeFileAtomic } from './serialization/json.ts';
import {
  assertSyncLocationSafe,
  resolveSyncLocation,
  syncGenerationDirectory,
  type SyncIdentity,
  type SyncLocation,
} from './syncLocation.ts';

/** Stable protocol shared by sync, the managed dispatcher, and runtime consumers. */
export const SYNC_REGISTRATION_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/u;
const PRIVATE_FILE_MODE = 0o600;

export interface SyncPackageRegistration {
  root: string;
  version: string;
  manifestPath: string;
  entry: string;
}

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
    manifestPath: requiredString(value.manifestPath, 'package manifest', recordPath),
    entry: requiredString(value.entry, 'package entry', recordPath),
  };
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validatePackage(value: SyncPackageRegistration, recordPath: string): void {
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
    pi?: { extensions?: unknown };
  };
  if (manifest.name !== DOOM_PACKAGE_NAME || manifest.version !== value.version) {
    throw new Error(`Doom sync registration at ${recordPath} does not match its DoomPi package`);
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
  if (registration.version !== SYNC_REGISTRATION_VERSION) {
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
  validatePackage(registration.package, recordPath);
  return registration;
}

function parseRegistration(value: unknown, recordPath: string): SyncRegistration {
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
    package: packageFrom(value.package, recordPath),
  };
}

/** Reads only the exact registration for this repository/worktree. */
export function readSyncRegistration(repoRoot: string, homeDirectory?: string): SyncRegistration | undefined {
  const location = resolveSyncLocation(repoRoot, homeDirectory);
  if (!fs.existsSync(location.registrationPath)) return undefined;
  const parsed = parseRegistration(
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
