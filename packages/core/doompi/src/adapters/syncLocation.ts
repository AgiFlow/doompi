import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PI_DIRECTORY = '.pi';
const DOOM_CONFIG_DIRECTORY = '.doom';
const SYNC_DIRECTORY = 'sync';
const WORKTREES_DIRECTORY = 'worktrees';
const SHARED_CACHE_DIRECTORY = 'shared-cache';
const LEGACY_DOOM_DIRECTORY = 'doom';
const GIT_DIRECTORY = '.git';
const COMMON_DIRECTORY_FILE = 'commondir';
const IDENTITY_HEX_LENGTH = 32;
const LABEL_MAX_LENGTH = 48;
const DEFAULT_REPOSITORY_LABEL = 'repo';
const DEFAULT_WORKTREE_LABEL = 'worktree';
const LOCK_FILE = '.sync.lock';
const STALE_LOCK_MS = 5 * 60 * 1000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface SyncIdentity {
  repositoryId: string;
  worktreeId: string;
}

export interface SyncLocation {
  identity: SyncIdentity;
  repositoryLabel: string;
  worktreeLabel: string;
  repositoryDirectory: string;
  sharedCacheDirectory: string;
  directory: string;
  statePath: string;
  legacyDirectory: string;
  legacyStatePath: string;
}

function canonicalPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function readGitDirectory(repositoryRoot: string): string | undefined {
  const gitPath = path.join(repositoryRoot, GIT_DIRECTORY);
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return canonicalPath(gitPath);
    if (!stat.isFile()) return undefined;
    const match = /^gitdir:\s*(.+)$/imu.exec(fs.readFileSync(gitPath, 'utf8').trim());
    return match?.[1] ? canonicalPath(path.resolve(repositoryRoot, match[1].trim())) : undefined;
  } catch {
    return undefined;
  }
}

function gitCommonDirectory(repositoryRoot: string): string | undefined {
  const gitDirectory = readGitDirectory(repositoryRoot);
  if (!gitDirectory) return undefined;
  try {
    const relative = fs.readFileSync(path.join(gitDirectory, COMMON_DIRECTORY_FILE), 'utf8').trim();
    return relative ? canonicalPath(path.resolve(gitDirectory, relative)) : gitDirectory;
  } catch {
    return gitDirectory;
  }
}

function identityHash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, IDENTITY_HEX_LENGTH);
}

export function sanitizeSyncLabel(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, LABEL_MAX_LENGTH)
    .replace(/[._-]+$/gu, '');
  return normalized === '' || normalized === '.' || normalized === '..' ? fallback : normalized;
}

function repositoryLabel(commonDirectory: string | undefined, repositoryRoot: string): string {
  if (!commonDirectory) return sanitizeSyncLabel(path.basename(repositoryRoot), DEFAULT_REPOSITORY_LABEL);
  const base = path.basename(commonDirectory);
  const source = base === GIT_DIRECTORY ? path.basename(path.dirname(commonDirectory)) : base;
  return sanitizeSyncLabel(source, DEFAULT_REPOSITORY_LABEL);
}

export function resolveSyncLocation(repositoryRoot: string, homeDirectory: string = os.homedir()): SyncLocation {
  const root = canonicalPath(repositoryRoot);
  const commonDirectory = gitCommonDirectory(root);
  const repositoryToken = commonDirectory ? `git:${commonDirectory}` : `root:${root}`;
  const identity: SyncIdentity = {
    repositoryId: identityHash(repositoryToken),
    worktreeId: identityHash(`${repositoryToken}\0worktree:${root}`),
  };
  const repoLabel = repositoryLabel(commonDirectory, root);
  const worktreeLabel = sanitizeSyncLabel(path.basename(root), DEFAULT_WORKTREE_LABEL);
  const generatedRoot = path.join(path.resolve(homeDirectory), PI_DIRECTORY, DOOM_CONFIG_DIRECTORY, SYNC_DIRECTORY);
  const repositoryDirectory = path.join(generatedRoot, `${repoLabel}--${identity.repositoryId}`);
  const directory = path.join(repositoryDirectory, WORKTREES_DIRECTORY, `${worktreeLabel}--${identity.worktreeId}`);
  const legacyDirectory = path.join(root, PI_DIRECTORY, LEGACY_DOOM_DIRECTORY);
  return {
    identity,
    repositoryLabel: repoLabel,
    worktreeLabel,
    repositoryDirectory,
    sharedCacheDirectory: path.join(repositoryDirectory, SHARED_CACHE_DIRECTORY),
    directory,
    statePath: path.join(directory, 'state.json'),
    legacyDirectory,
    legacyStatePath: path.join(legacyDirectory, 'state.json'),
  };
}

function rejectSymlink(target: string): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw new Error(`Doom sync namespace must not contain a symbolic link: ${target}`);
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

function removeStaleLock(lockPath: string): void {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) fs.rmSync(lockPath, { force: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

/** Acquires the exclusive publisher lock for one worktree namespace. */
export async function acquireSyncLocationLock(location: SyncLocation): Promise<() => Promise<void>> {
  assertSyncLocationSafe(location);
  await fs.promises.mkdir(location.directory, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  await fs.promises.chmod(location.directory, PRIVATE_DIRECTORY_MODE);
  const lockPath = path.join(location.directory, LOCK_FILE);
  removeStaleLock(lockPath);
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(lockPath, 'wx', PRIVATE_FILE_MODE);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`Another Doom sync is already publishing ${location.directory}`);
    }
    throw error;
  }
  await handle.writeFile(`${process.pid}\n`);
  return async () => {
    await handle.close();
    await fs.promises.rm(lockPath, { force: true });
  };
}

/** Refuses generated namespace redirection before a writer creates or prunes it. */
export function assertSyncLocationSafe(location: SyncLocation): void {
  const syncRoot = path.dirname(location.repositoryDirectory);
  const doomRoot = path.dirname(syncRoot);
  const piRoot = path.dirname(doomRoot);
  const worktreesRoot = path.dirname(location.directory);
  for (const target of [piRoot, doomRoot, syncRoot, location.repositoryDirectory, worktreesRoot, location.directory]) {
    rejectSymlink(target);
  }
}
