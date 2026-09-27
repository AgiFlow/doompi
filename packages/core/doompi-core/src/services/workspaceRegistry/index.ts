import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { gitCommonDirectory } from '../syncLocation';

const REGISTRY_FILE = 'workspaces.json';
/** Kept in the repository's git data, which moves with the checkout and is shared by its worktrees. */
const WORKSPACE_MARKER_FILE = 'doompi-workspace-id';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface WorkspaceRecord {
  id: string;
  root: string;
  /** Display name chosen when the workspace was added; the folder basename stands in when absent. */
  name?: string;
}

export interface WorkspaceRegistry {
  list(): readonly WorkspaceRecord[];
  add(record: WorkspaceRecord): void;
  remove(id: string): void;
}

export interface WorkspaceRegistryOptions {
  directory: string;
  onNotice?: (message: string) => void;
}

function parseRecord(value: unknown): WorkspaceRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '') return undefined;
  if (typeof record.root !== 'string' || !path.isAbsolute(record.root)) return undefined;
  const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name : undefined;
  return { id: record.id, root: record.root, ...(name === undefined ? {} : { name }) };
}

/** Durable workspace membership, independent of whether a workspace can currently mount. */
export function createWorkspaceRegistry(options: WorkspaceRegistryOptions): WorkspaceRegistry {
  const notice = options.onNotice ?? ((): void => {});
  const filePath = path.join(options.directory, REGISTRY_FILE);

  const load = (): WorkspaceRecord[] => {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      notice(`${filePath} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      notice(`workspaces at ${filePath} are not valid JSON; none will be restored`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      notice(`workspaces at ${filePath} are not a list; none will be restored`);
      return [];
    }
    const records: WorkspaceRecord[] = [];
    for (const entry of parsed) {
      const record = parseRecord(entry);
      if (record === undefined) notice(`workspaces at ${filePath} contain an unusable entry; skipping it`);
      else if (!records.some((candidate) => candidate.id === record.id)) records.push(record);
    }
    return records;
  };

  let current = load();

  const persist = (next: readonly WorkspaceRecord[]): void => {
    const temporary = `${filePath}.${String(process.pid)}.tmp`;
    try {
      fs.mkdirSync(options.directory, { recursive: true, mode: DIRECTORY_MODE });
      fs.writeFileSync(temporary, `${JSON.stringify(next, undefined, 2)}\n`, { mode: FILE_MODE });
      fs.renameSync(temporary, filePath);
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch (cleanupError) {
        notice(
          `${temporary} could not be removed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      throw new Error(`${filePath} could not be saved`, { cause: error });
    }
  };

  return {
    list: () => current,
    add(record) {
      if (record.id === '' || !path.isAbsolute(record.root)) throw new Error('Invalid workspace record.');
      // Replaced in place: registry order is the tie-break when checkouts are matched to workspaces.
      const next = current.some((held) => held.id === record.id)
        ? current.map((held) => (held.id === record.id ? record : held))
        : [...current, record];
      persist(next);
      current = next;
    },
    remove(id) {
      const next = current.filter((held) => held.id !== id);
      if (next.length === current.length) return;
      persist(next);
      current = next;
    },
  };
}

/** The workspace id recorded in a checkout's git data, if any. */
export function readWorkspaceMarker(checkoutRoot: string): string | undefined {
  const commonDirectory = gitCommonDirectory(checkoutRoot);
  if (commonDirectory === undefined) return undefined;
  try {
    const id = fs.readFileSync(path.join(commonDirectory, WORKSPACE_MARKER_FILE), 'utf8').trim();
    return id === '' ? undefined : id;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Records a workspace id in a checkout's git data so the workspace keeps its id when the
 * repository moves. A checkout without git data has nowhere to keep it; returns false.
 */
export function writeWorkspaceMarker(checkoutRoot: string, id: string): boolean {
  const commonDirectory = gitCommonDirectory(checkoutRoot);
  if (commonDirectory === undefined) return false;
  fs.writeFileSync(path.join(commonDirectory, WORKSPACE_MARKER_FILE), `${id}\n`, { mode: FILE_MODE });
  return true;
}

export interface WorkspaceIdentity {
  readonly id: string;
  /** The workspace root. Differs from the checkout when the checkout joins an existing workspace. */
  readonly root: string;
  /** The recorded root no longer exists and this checkout takes its place. */
  readonly moved: boolean;
}

/**
 * Decides which workspace a checkout belongs to. An exact root match wins. Otherwise the id
 * in the repository's git data names the workspace: a checkout of a workspace whose root still
 * exists joins it, and one whose recorded root is gone is that workspace, moved. Anything else
 * is a new workspace.
 */
export function identifyWorkspace(input: {
  readonly records: readonly WorkspaceRecord[];
  readonly checkoutRoot: string;
  readonly marker?: string;
  readonly exists?: (root: string) => boolean;
  readonly newId?: () => string;
}): WorkspaceIdentity {
  const exact = input.records.find((record) => record.root === input.checkoutRoot);
  if (exact !== undefined) return { id: exact.id, root: exact.root, moved: false };
  const owner = input.marker === undefined ? undefined : input.records.find((record) => record.id === input.marker);
  if (owner !== undefined) {
    const exists = input.exists ?? fs.existsSync;
    return exists(owner.root)
      ? { id: owner.id, root: owner.root, moved: false }
      : { id: owner.id, root: input.checkoutRoot, moved: true };
  }
  return { id: input.marker ?? (input.newId ?? crypto.randomUUID)(), root: input.checkoutRoot, moved: false };
}
