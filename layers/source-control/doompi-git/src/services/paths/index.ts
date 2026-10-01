import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { WORKTREE_RECORD_VERSION, type WorktreeRecord } from '../../types/worktreeRegistry';
import { readJson, writeJsonAtomic } from '../atomicJson';
import { repositoryId } from '../repositoryIdentity';

/**
 * Where this package keeps its own state.
 *
 * Outside the repository on purpose. A worktree directory inside the checkout
 * would be found by every glob the repository's own tooling runs, and would
 * resolve workspace imports against the parent checkout rather than the
 * worktree, so a session there would build the wrong source while appearing to
 * work.
 */
export function doomGitRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.pi', '.doom', 'git');
}

/** The directory every worktree for every repository is created under. */
export function worktreesRoot(homeDir: string = os.homedir()): string {
  return path.join(doomGitRoot(homeDir), 'worktrees');
}

/**
 * Remote auth for every workspace, one entry per workspace root.
 *
 * Outside every repository, so a token can never be committed, and readable
 * only by the owner. It holds secrets, which no other file here does.
 */
export function credentialsFile(homeDir: string = os.homedir()): string {
  return path.join(doomGitRoot(homeDir), 'credentials.json');
}
/** One registry file per repository, keyed by the shared git directory. */
export function registryFile(repositoryRoot: string, homeDir: string = os.homedir()): string {
  const id = repositoryId(repositoryRoot);
  const root = path.join(doomGitRoot(homeDir), 'registry');
  const canonical = path.join(root, id, 'worktrees.json');
  if (fs.existsSync(canonical)) return canonical;
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return canonical;
  }
  const legacyFiles = names
    .filter((entry) => entry.endsWith(`--${id}`))
    .sort()
    .map((entry) => path.join(root, entry, 'worktrees.json'))
    .filter((file) => fs.existsSync(file));
  if (legacyFiles.length === 0) return canonical;
  const entries = new Map<string, WorktreeRecord>();
  for (const file of legacyFiles) {
    const legacy = readJson<{ version?: unknown; entries?: unknown }>(file);
    if (legacy?.version !== WORKTREE_RECORD_VERSION || !Array.isArray(legacy.entries)) continue;
    for (const value of legacy.entries) {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('id' in value) ||
        typeof value.id !== 'string' ||
        value.id === ''
      )
        continue;
      const entry = value as WorktreeRecord;
      const existing = entries.get(entry.id);
      if (existing !== undefined && !isDeepStrictEqual(existing, entry)) {
        throw new Error(`Conflicting legacy worktree registry entries for '${entry.id}'.`);
      }
      entries.set(entry.id, entry);
    }
  }
  const temporary = `${canonical}.${randomUUID()}.migration`;
  writeJsonAtomic(temporary, { version: WORKTREE_RECORD_VERSION, entries: [...entries.values()] });
  try {
    // Publish only if absent. A concurrent writer may already have added records.
    fs.linkSync(temporary, canonical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    fs.rmSync(temporary);
  }
  return canonical;
}
