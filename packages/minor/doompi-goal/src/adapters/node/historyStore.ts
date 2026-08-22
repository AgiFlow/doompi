import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  decodeGoalHistoryDocument,
  emptyGoalHistoryDocument,
  GOAL_HISTORY_MAX_BYTES,
  goalHistorySerializedSize,
  isGoalHistoryEntry,
  pruneGoalHistoryDocument,
  sortGoalHistoryNewestFirst,
} from '../../services/history/historyPolicy.ts';
import type { GoalHistoryDocument, GoalHistoryEntry, RepositoryIdentity } from '../../types/history.ts';
import { type HistoryLockOptions, withHistoryLock } from './historyLock.ts';
import { type RepositoryIdentityOptions, resolveRepositoryIdentity } from './repositoryIdentity.ts';

const HISTORY_DIRECTORY = 'goal-history';
const CORRUPT_DIRECTORY = 'corrupt';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export interface HistoryStoreOptions extends RepositoryIdentityOptions {
  agentDir?: string;
  lock?: HistoryLockOptions;
  now?: () => Date;
}

/** Returns false when the host filesystem cannot provide directory durability. */
function syncDirectory(directory: string): boolean {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return true;
  } catch {
    // The file rename is already atomic; unsupported directory sync falls back to that guarantee.
    return false;
  }
}

function writeAtomic(filePath: string, document: GoalHistoryDocument): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'w', PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporaryPath, PRIVATE_FILE_MODE);
    fs.renameSync(temporaryPath, filePath);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/** Returns false when another repair already moved the corrupt file. */
function quarantine(filePath: string, corruptDirectory: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  fs.mkdirSync(corruptDirectory, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  const destination = path.join(corruptDirectory, `${path.basename(filePath)}.${Date.now()}.${randomUUID()}.json`);
  try {
    fs.renameSync(filePath, destination);
    return true;
  } catch (error) {
    if (!fs.existsSync(filePath)) return false;
    throw new Error(`Goal history at '${filePath}' could not be quarantined.`, { cause: error });
  }
}

export class GoalHistoryStore {
  readonly identity: RepositoryIdentity;
  readonly historyDirectory: string;
  readonly filePath: string;
  readonly lockPath: string;
  readonly corruptDirectory: string;
  private readonly lockOptions: HistoryLockOptions;
  private readonly now: () => Date;

  constructor(cwd: string, options: HistoryStoreOptions = {}) {
    this.identity = resolveRepositoryIdentity(cwd, options);
    const agentDirectory = options.agentDir ?? getAgentDir();
    this.historyDirectory = path.join(agentDirectory, HISTORY_DIRECTORY);
    this.filePath = path.join(this.historyDirectory, `${this.identity.hash}.json`);
    this.lockPath = `${this.filePath}.lock`;
    this.corruptDirectory = path.join(this.historyDirectory, CORRUPT_DIRECTORY);
    this.lockOptions = options.lock ?? {};
    this.now = options.now ?? (() => new Date());
  }

  async readDocument(): Promise<GoalHistoryDocument> {
    return withHistoryLock(this.lockPath, () => this.readDocumentUnlocked(), this.lockOptions);
  }

  async list(): Promise<GoalHistoryEntry[]> {
    return sortGoalHistoryNewestFirst((await this.readDocument()).entries);
  }

  async archive(entry: GoalHistoryEntry): Promise<GoalHistoryEntry> {
    if (!isGoalHistoryEntry(entry)) throw new Error('Goal history entries are malformed.');
    return withHistoryLock(
      this.lockPath,
      () => {
        const document = this.readDocumentUnlocked();
        if (document.tombstones.some((tombstone) => tombstone.id === entry.id))
          throw new Error(`Goal history entry '${entry.id}' was explicitly removed.`);
        const existing = document.entries.find((candidate) => candidate.id === entry.id);
        if (existing) return existing;
        document.entries.push({ ...entry });
        document.revision += 1;
        pruneGoalHistoryDocument(document, entry.id);
        if (goalHistorySerializedSize(document) > GOAL_HISTORY_MAX_BYTES)
          throw new Error('Goal history exceeds the 1 MiB storage limit.');
        writeAtomic(this.filePath, document);
        return entry;
      },
      this.lockOptions,
    );
  }

  async remove(id: string): Promise<void> {
    if (!id) throw new Error('Goal history removal requires an id.');
    await withHistoryLock(
      this.lockPath,
      () => {
        const document = this.readDocumentUnlocked();
        document.entries = document.entries.filter((entry) => entry.id !== id);
        if (!document.tombstones.some((tombstone) => tombstone.id === id))
          document.tombstones.push({ id, removedAt: this.now().toISOString() });
        document.revision += 1;
        pruneGoalHistoryDocument(document);
        writeAtomic(this.filePath, document);
      },
      this.lockOptions,
    );
  }

  private readDocumentUnlocked(): GoalHistoryDocument {
    if (!fs.existsSync(this.filePath)) return emptyGoalHistoryDocument(this.identity);
    try {
      return decodeGoalHistoryDocument(JSON.parse(fs.readFileSync(this.filePath, 'utf8')), this.identity);
    } catch (error) {
      quarantine(this.filePath, this.corruptDirectory);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Goal history was quarantined: ${message}`, { cause: error });
    }
  }
}
