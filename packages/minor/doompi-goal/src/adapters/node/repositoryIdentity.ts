import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RepositoryIdentity } from '../../types/history.ts';

const GIT_DIR = '.git';
const DOOM_DIR = '.doom';
const PROJECT_MARKERS = ['package.json', 'pnpm-workspace.yaml', 'doompi.json'];

export interface RepositoryIdentityOptions {
  doompiRoot?: string;
  realpath?: (value: string) => string;
}

function canonicalPath(value: string, realpath: (value: string) => string): string {
  const absolute = path.resolve(value);
  let resolved = absolute;
  try {
    resolved = realpath(absolute);
  } catch {
    // Use a normalized absolute path for a not-yet-created directory.
  }
  const normalized = path.normalize(resolved);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function existingDirectory(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return fs.statSync(value).isDirectory() ? value : null;
  } catch {
    return null;
  }
}

function ancestorDirectories(start: string): string[] {
  const result: string[] = [];
  let current = path.resolve(start);
  while (true) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

function readGitDirectory(root: string): string | null {
  const gitPath = path.join(root, GIT_DIR);
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return gitPath;
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(gitPath, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/im.exec(content);
    return match ? path.resolve(root, match[1].trim()) : null;
  } catch {
    return null;
  }
}

function resolveCommonDirectory(gitDirectory: string): string {
  try {
    const relativeCommon = fs.readFileSync(path.join(gitDirectory, 'commondir'), 'utf8').trim();
    if (relativeCommon) return path.resolve(gitDirectory, relativeCommon);
  } catch {
    // Normal repositories have no commondir file.
  }
  return gitDirectory;
}

function makeIdentity(token: string, root: string): RepositoryIdentity {
  return { token, root, hash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

function findGitIdentity(cwd: string, realpath: (value: string) => string): RepositoryIdentity | null {
  for (const candidate of ancestorDirectories(cwd)) {
    const gitDirectory = readGitDirectory(candidate);
    if (!gitDirectory) continue;
    const commonDirectory = canonicalPath(resolveCommonDirectory(gitDirectory), realpath);
    return makeIdentity(`git:${commonDirectory}`, canonicalPath(candidate, realpath));
  }
  return null;
}

function findMarkerRoot(cwd: string, realpath: (value: string) => string): string | null {
  for (const candidate of ancestorDirectories(cwd)) {
    if (fs.existsSync(path.join(candidate, DOOM_DIR))) return canonicalPath(candidate, realpath);
    if (PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(candidate, marker)))) {
      return canonicalPath(candidate, realpath);
    }
  }
  return null;
}

/** Resolve canonical repository identity, sharing linked worktrees. */
export function resolveRepositoryIdentity(cwd: string, options: RepositoryIdentityOptions = {}): RepositoryIdentity {
  const realpath = options.realpath ?? fs.realpathSync.native;
  const nearestGit = findGitIdentity(cwd, realpath);
  if (nearestGit) return nearestGit;

  const configuredRoot = existingDirectory(options.doompiRoot ?? process.env.DOOMPI_ROOT);
  if (configuredRoot) {
    const root = canonicalPath(configuredRoot, realpath);
    return makeIdentity(`root:${root}`, root);
  }

  const markerRoot = findMarkerRoot(cwd, realpath);
  if (markerRoot) return makeIdentity(`root:${markerRoot}`, markerRoot);
  const root = canonicalPath(cwd, realpath);
  return makeIdentity(`cwd:${root}`, root);
}

export function historyKeyForRepository(cwd: string, options?: RepositoryIdentityOptions): string {
  return resolveRepositoryIdentity(cwd, options).hash;
}

export function canonicalRepositoryPath(value: string): string {
  return canonicalPath(value, fs.realpathSync.native);
}
