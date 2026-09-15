import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PI_DIRECTORY = '.pi';
const DOOM_CONFIG_DIRECTORY = '.doom';
const SYNC_DIRECTORY = 'sync';
const WORKTREES_DIRECTORY = 'worktrees';
const SKILL_CACHE_SEGMENTS = ['cache', 'skills'];
const GIT_DIRECTORY = '.git';
const COMMON_DIRECTORY_FILE = 'commondir';
const IDENTITY_HEX_LENGTH = 32;
const LABEL_MAX_LENGTH = 48;
const DEFAULT_REPOSITORY_LABEL = 'repo';
const DEFAULT_WORKTREE_LABEL = 'worktree';

/**
 * The home-scoped skill manifest cache for one worktree.
 *
 * This mirrors the namespace the DoomPi launcher publishes into, so a session
 * that stages resources through the launcher and one that stages them through a
 * `/domains` switch hit the same manifests instead of rescanning every tree.
 * Two worktrees of one repository stay separate, and a checkout reached through
 * a symlink resolves to the same identity as the real path.
 */
export function resolveSkillCacheDirectory(repositoryRoot: string, homeDirectory: string = os.homedir()): string {
  const root = canonicalPath(repositoryRoot);
  const commonDirectory = gitCommonDirectory(root);
  const repositoryToken = commonDirectory ? `git:${commonDirectory}` : `root:${root}`;
  const repositoryId = identityHash(repositoryToken);
  const worktreeId = identityHash(`${repositoryToken}\0worktree:${root}`);
  const repoLabel = repositoryLabel(commonDirectory, root);
  const worktreeLabel = sanitizeSyncLabel(path.basename(root), DEFAULT_WORKTREE_LABEL);
  return path.join(
    path.resolve(homeDirectory),
    PI_DIRECTORY,
    DOOM_CONFIG_DIRECTORY,
    SYNC_DIRECTORY,
    `${repoLabel}--${repositoryId}`,
    WORKTREES_DIRECTORY,
    `${worktreeLabel}--${worktreeId}`,
    ...SKILL_CACHE_SEGMENTS,
  );
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

/** Keeps a repository or worktree name usable as one path segment. */
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
