import fs from 'node:fs';
import path from 'node:path';

const REGISTRY_FILE = 'workspaces.json';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface WorkspaceRecord {
  id: string;
  root: string;
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
  return { id: record.id, root: record.root };
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
      const next = [...current.filter((held) => held.id !== record.id), record];
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
