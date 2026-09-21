import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { REGISTRY_DIR_ENV, resolveRegistryDir } from '@agimon-ai/doompi-core/web';

import { WORKTREE_RECORD_VERSION, type WorktreeRecord } from '../../types/worktreeRegistry';
import { readJson, writeJsonAtomic } from '../atomicJson';
import { repositoryId } from '../repositoryIdentity';

const REGISTRY_DIR_FLAG = '--registry-dir';

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

/**
 * The session registry directory this process's hub is watching.
 *
 * A spawned session only appears in the rail if it registers in the same
 * directory the hub watches, and the hub passes that directory to its children
 * as `--registry-dir` while also inheriting the env var. Recovering it from
 * this process's own argv and env, in the same precedence the hub and the
 * session server use, is what makes a worktree session visible rather than
 * silently invisible.
 */
export function hubRegistryDir(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const index = argv.indexOf(REGISTRY_DIR_FLAG);
  const flagValue = index >= 0 ? argv[index + 1] : undefined;
  return resolveRegistryDir({
    ...(flagValue === undefined ? {} : { flagValue }),
    ...(env[REGISTRY_DIR_ENV] === undefined ? {} : { envValue: env[REGISTRY_DIR_ENV] }),
    homeDir,
  });
}
