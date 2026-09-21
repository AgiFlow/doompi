import fs from 'node:fs';
import path from 'node:path';

const REGISTRY_FILE = 'open-sessions.json';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** The id becomes a journal filename, so it is constrained exactly as SQLite storage constrains it. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

/** One cockpit session the server had open, enough to reopen its journal by id. */
export interface OpenSessionRecord {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  name: string;
  createdAt: string;
  parentSessionId?: string;
  sessionProvenance?: string;
}

export interface OpenSessionRegistry {
  list(): readonly OpenSessionRecord[];
  /** True only after the record is durably published. */
  add(record: OpenSessionRecord): boolean;
  remove(sessionId: string): void;
}

export interface OpenSessionRegistryOptions {
  /** Directory holding the `sessions` journal folder, so the registry sits beside what it points at. */
  directory: string;
  onNotice?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Reads one entry, or nothing.
 *
 * The file is editable by hand and its session id is joined into a journal
 * path, so it is a trust boundary rather than trusted state this process wrote.
 * A bad entry is dropped instead of narrowing the whole file to nothing.
 */
function parseRecord(value: unknown): OpenSessionRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { sessionId, workspaceId, cwd, name, createdAt } = value;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return undefined;
  if (typeof workspaceId !== 'string' || workspaceId === '') return undefined;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return undefined;
  if (typeof name !== 'string' || typeof createdAt !== 'string') return undefined;
  const parentSessionId = optionalText(value.parentSessionId);
  const sessionProvenance = optionalText(value.sessionProvenance);
  return {
    sessionId,
    workspaceId,
    cwd,
    name,
    createdAt,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(sessionProvenance === undefined ? {} : { sessionProvenance }),
  };
}

/**
 * The sessions the cockpit had open, so a server restart can offer them back.
 *
 * Journals already survive a restart; what does not is the knowledge of which
 * of them were open rather than merely finished. Without that, a restart either
 * loses every session or revives every thread ever recorded.
 */
export function createOpenSessionRegistry(options: OpenSessionRegistryOptions): OpenSessionRegistry {
  const notice = options.onNotice ?? ((): void => {});
  const filePath = path.join(options.directory, REGISTRY_FILE);

  const load = (): OpenSessionRecord[] => {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      // No file is the normal first run, so this is not worth a notice.
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Left in place rather than rewritten: a file somebody hand-edited is
      // worth more as evidence than as something this process silently repairs.
      notice(`open sessions at ${filePath} are not valid JSON; none will be restored`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      notice(`open sessions at ${filePath} are not a list; none will be restored`);
      return [];
    }
    const records: OpenSessionRecord[] = [];
    for (const entry of parsed) {
      const record = parseRecord(entry);
      if (record === undefined) notice(`open sessions at ${filePath} contain an unusable entry; skipping it`);
      else records.push(record);
    }
    return records;
  };

  let current = load();

  const persist = (next: OpenSessionRecord[]): boolean => {
    const temporary = `${filePath}.${String(process.pid)}.tmp`;
    try {
      fs.mkdirSync(options.directory, { recursive: true, mode: DIRECTORY_MODE });
      const descriptor = fs.openSync(temporary, 'w', FILE_MODE);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(next, undefined, 2)}\n`);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      // Rename rather than write in place, so a crash mid-write leaves the
      // previous contents rather than a truncated file.
      fs.renameSync(temporary, filePath);
      current = next;
      return true;
    } catch (error) {
      notice(`${filePath} could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing further to do; the temp file is inert either way.
      }
      return false;
    }
  };

  return {
    list: () => current,
    add(record) {
      if (!SESSION_ID_PATTERN.test(record.sessionId)) throw new Error(`Invalid session id '${record.sessionId}'.`);
      return persist([...current.filter((held) => held.sessionId !== record.sessionId), record]);
    },
    remove(sessionId) {
      const next = current.filter((held) => held.sessionId !== sessionId);
      if (next.length === current.length) return;
      persist(next);
    },
  };
}
