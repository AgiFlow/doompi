import {
  WORKTREE_RECORD_VERSION,
  type WorktreeRecord,
  type WorktreeRegistryFile,
  type WorktreeRegistryStore,
} from '../../types/worktreeRegistry';
import { readJson, writeJsonAtomic } from '../atomicJson';

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
 * The worktree registry for one repository, as a single JSON file.
 *
 * One file rather than a file per worktree, and read-modify-write rather than
 * merging: every write comes from a tool call in one session's turn, so there
 * is no concurrent writer to reconcile with. Choosing the simpler shape now
 * means a reader can see the whole registry in one place; if concurrent writers
 * ever appear, that is the point to revisit, not before.
 *
 * A file that does not parse is treated as empty rather than fatal. Losing
 * track of worktrees is recoverable through prune; refusing to run is not.
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
  };
}
