import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

import {
  WORKTREE_RECORD_VERSION,
  type WorktreeRecord,
  type WorktreeRegistryFile,
  type WorktreeRegistryStore,
} from '../../types/worktreeRegistry';
import { readJson, writeJsonAtomic } from '../atomicJson';
import { DoomGitExpectedError } from '../errors';

const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 25;

function isRecord(value: unknown): value is WorktreeRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<WorktreeRecord>;
  return (
    record.version === WORKTREE_RECORD_VERSION &&
    typeof record.id === 'string' &&
    record.id !== '' &&
    typeof record.path === 'string' &&
    typeof record.branch === 'string' &&
    typeof record.sessionId === 'string'
  );
}

/**
 * Repository mutations hold an exclusive directory lock from the read through
 * the final commit. This works across independently loaded packages and hosts.
 * A crashed owner leaves a visible lock, never a lease another writer may steal.
 */
export function createWorktreeRegistry(file: string): WorktreeRegistryStore {
  return {
    list() {
      const parsed = readJson<WorktreeRegistryFile>(file);
      if (!parsed || parsed.version !== WORKTREE_RECORD_VERSION || !Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(isRecord);
    },
    replace(entries) {
      writeJsonAtomic(file, { version: WORKTREE_RECORD_VERSION, entries } satisfies WorktreeRegistryFile);
    },
    async transaction(operation, signal) {
      const lock = `${file}.lock`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const deadline = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        signal?.throwIfAborted();
        try {
          fs.mkdirSync(lock, { mode: 0o700 });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (Date.now() >= deadline)
            throw new DoomGitExpectedError(
              'registry_busy',
              'Another worktree operation holds the repository registry.',
              true,
              'Retry after it finishes. After a host crash, inspect and remove the abandoned worktrees.json.lock directory.',
            );
          await setTimeout(LOCK_RETRY_MS, undefined, { signal });
        }
      }
      try {
        fs.writeFileSync(
          path.join(lock, 'owner.json'),
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
          { mode: 0o600 },
        );
        signal?.throwIfAborted();
        return await operation();
      } finally {
        fs.rmSync(lock, { recursive: true });
      }
    },
  };
}
