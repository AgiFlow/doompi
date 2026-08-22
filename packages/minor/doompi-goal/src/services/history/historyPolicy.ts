import type {
  GoalHistoryDocument,
  GoalHistoryEntry,
  GoalHistoryTombstone,
  RepositoryIdentity,
} from '../../types/history.ts';

export const GOAL_HISTORY_MAX_ENTRIES = 100;
export const GOAL_HISTORY_MAX_TOMBSTONES = 100;
export const GOAL_HISTORY_MAX_BYTES = 1024 * 1024;

const HISTORY_STATUSES = new Set<GoalHistoryEntry['status']>([
  'active',
  'queued',
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
  'complete',
]);

export function emptyGoalHistoryDocument(identity: RepositoryIdentity): GoalHistoryDocument {
  return { version: 1, repositoryIdentity: identity.token, revision: 0, entries: [], tombstones: [] };
}

export function isGoalHistoryEntry(value: unknown): value is GoalHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<GoalHistoryEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.objective === 'string' &&
    HISTORY_STATUSES.has(entry.status as GoalHistoryEntry['status']) &&
    typeof entry.archivedAt === 'string'
  );
}

function isGoalHistoryTombstone(value: unknown): value is GoalHistoryTombstone {
  if (!value || typeof value !== 'object') return false;
  const tombstone = value as Partial<GoalHistoryTombstone>;
  return typeof tombstone.id === 'string' && typeof tombstone.removedAt === 'string';
}

export function decodeGoalHistoryDocument(value: unknown, identity: RepositoryIdentity): GoalHistoryDocument {
  if (!value || typeof value !== 'object') throw new Error('Goal history must contain an object.');
  const candidate = value as Partial<GoalHistoryDocument>;
  const revision = candidate.revision;
  const entries = candidate.entries;
  const tombstones = candidate.tombstones;
  if (
    candidate.version !== 1 ||
    candidate.repositoryIdentity !== identity.token ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 0 ||
    !Array.isArray(entries) ||
    !entries.every(isGoalHistoryEntry) ||
    !Array.isArray(tombstones) ||
    !tombstones.every(isGoalHistoryTombstone)
  ) {
    throw new Error('Goal history document is malformed or belongs to another repository.');
  }
  if (revision === undefined || entries === undefined || tombstones === undefined) {
    throw new Error('Goal history document is incomplete.');
  }
  return {
    version: 1,
    repositoryIdentity: identity.token,
    revision,
    entries: [...entries],
    tombstones: [...tombstones],
  };
}

export function goalHistorySerializedSize(document: GoalHistoryDocument): number {
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`).byteLength;
}

export function sortGoalHistoryNewestFirst(entries: GoalHistoryEntry[]): GoalHistoryEntry[] {
  return [...entries].sort(
    (left, right) => right.archivedAt.localeCompare(left.archivedAt) || right.id.localeCompare(left.id),
  );
}

export function pruneGoalHistoryDocument(document: GoalHistoryDocument, protectedId?: string): void {
  document.entries = sortGoalHistoryNewestFirst(document.entries);
  if (document.entries.length > GOAL_HISTORY_MAX_ENTRIES) {
    const retained = document.entries.slice(0, GOAL_HISTORY_MAX_ENTRIES);
    const protectedEntry = document.entries.find((entry) => entry.id === protectedId);
    if (protectedEntry && !retained.some((entry) => entry.id === protectedId)) {
      retained[GOAL_HISTORY_MAX_ENTRIES - 1] = protectedEntry;
    }
    document.entries = retained;
  }
  document.tombstones = [...document.tombstones]
    .sort((left, right) => right.removedAt.localeCompare(left.removedAt) || right.id.localeCompare(left.id))
    .slice(0, GOAL_HISTORY_MAX_TOMBSTONES);
  while (goalHistorySerializedSize(document) > GOAL_HISTORY_MAX_BYTES && document.entries.length > 0) {
    const removable = document.entries.findIndex((entry) => entry.id !== protectedId);
    if (removable < 0) break;
    document.entries.splice(removable, 1);
  }
  while (goalHistorySerializedSize(document) > GOAL_HISTORY_MAX_BYTES && document.tombstones.length > 0) {
    document.tombstones.pop();
  }
}
