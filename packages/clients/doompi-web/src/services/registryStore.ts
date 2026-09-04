import { SESSION_RECORD_VERSION, type SessionRecord } from '../types/registry.ts';

const RECORD_EXTENSION = '.json';
const REQUIRED_STRINGS = ['id', 'cwd', 'socketPath', 'tokenFile', 'createdAt'] as const;

/** Environment variable overriding where session records live. */
export const REGISTRY_DIR_ENV = 'DOOMPI_RUNTIME_DIR';

const DEFAULT_RUN_DIR_SEGMENT = '.doompi/run';
const SESSIONS_SEGMENT = 'sessions';

export interface RegistryDirInput {
  /** Value of --registry-dir, when given; wins over everything else. */
  readonly flagValue?: string;
  /** Value of DOOMPI_RUNTIME_DIR, when set. */
  readonly envValue?: string;
  /** The user's home directory, supplied by the host. */
  readonly homeDir: string;
}

/** Mirrors doompi-server's resolution so both sides land on the same directory. */
export function resolveRegistryDir(input: RegistryDirInput): string {
  if (input.flagValue) return input.flagValue;
  if (input.envValue) return input.envValue;
  return `${input.homeDir}/${DEFAULT_RUN_DIR_SEGMENT}`;
}

/** Directory the watcher scans for record files. */
export function sessionRecordsDir(registryDir: string): string {
  return `${registryDir}/${SESSIONS_SEGMENT}`;
}

export function sessionRecordPath(registryDir: string, sessionId: string): string {
  return `${sessionRecordsDir(registryDir)}/${sessionId}${RECORD_EXTENSION}`;
}

export function isRecordFileName(name: string): boolean {
  return name.endsWith(RECORD_EXTENSION);
}

/**
 * Validates one record file's content.
 *
 * Returns undefined for anything that is not a well-formed current-version
 * record: a truncated write, a foreign file, or a future format this build
 * does not understand. The watcher simply skips such files.
 */
export function parseSessionRecord(raw: string): SessionRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.version !== SESSION_RECORD_VERSION) return undefined;
  for (const key of REQUIRED_STRINGS) {
    if (typeof record[key] !== 'string' || record[key] === '') return undefined;
  }
  if (typeof record.name !== 'string') return undefined;
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return undefined;
  return {
    version: SESSION_RECORD_VERSION,
    id: record.id as string,
    name: record.name,
    cwd: record.cwd as string,
    socketPath: record.socketPath as string,
    tokenFile: record.tokenFile as string,
    // Optional: a server that mounted no package API omits it, and so does an
    // older one that predates the field.
    ...(typeof record.apiSocketPath === 'string' && record.apiSocketPath !== ''
      ? { apiSocketPath: record.apiSocketPath }
      : {}),
    // Also optional: a server predating the protocol socket serves only the
    // framed one, and a client that needs the protocol says so itself.
    ...(typeof record.protocolSocketPath === 'string' && record.protocolSocketPath !== ''
      ? { protocolSocketPath: record.protocolSocketPath }
      : {}),
    ...(typeof record.protocolServerId === 'string' && record.protocolServerId !== ''
      ? { protocolServerId: record.protocolServerId }
      : {}),
    pid: record.pid,
    createdAt: record.createdAt as string,
  };
}
