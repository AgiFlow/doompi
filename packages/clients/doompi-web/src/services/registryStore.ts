import { REGISTRY_DIR_ENV, resolveRegistryDir } from '@agimon-ai/doompi-web-contracts';
import { SESSION_RECORD_VERSION, type SessionRecord } from '../types/registry.ts';

const RECORD_EXTENSION = '.json';
const REQUIRED_STRINGS = ['id', 'cwd', 'socketPath', 'tokenFile', 'createdAt'] as const;

// Registry-dir resolution is defined once in doompi-web-contracts, because the
// hub, the session server, and any package that spawns a session have to land
// on the same directory or a spawned session never appears in the rail. These
// re-exports keep this module's existing callers unchanged.
export { REGISTRY_DIR_ENV, resolveRegistryDir };
export type { RegistryDirInput } from '@agimon-ai/doompi-web-contracts';

const SESSIONS_SEGMENT = 'sessions';

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

function parseServerComposition(value: unknown): SessionRecord['serverComposition'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['root', 'apiDirectory', 'generation', 'fingerprint', 'majorMode']) {
    if (typeof record[key] !== 'string' || record[key].trim() === '' || record[key].includes('\0')) return undefined;
  }
  if (!/^[a-f0-9]{64}$/u.test(record.fingerprint as string)) return undefined;
  if (
    !Array.isArray(record.activeLayers) ||
    record.activeLayers.some((layer) => typeof layer !== 'string' || layer === '')
  )
    return undefined;
  return {
    root: record.root as string,
    apiDirectory: record.apiDirectory as string,
    generation: record.generation as string,
    fingerprint: record.fingerprint as string,
    majorMode: record.majorMode as string,
    activeLayers: [...record.activeLayers] as string[],
  };
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
  const serverComposition = parseServerComposition(record.serverComposition);
  if (record.serverComposition !== undefined && serverComposition === undefined) return undefined;
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
    ...(serverComposition === undefined ? {} : { serverComposition }),
    pid: record.pid,
    createdAt: record.createdAt as string,
  };
}
