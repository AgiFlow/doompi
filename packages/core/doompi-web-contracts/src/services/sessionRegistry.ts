import type { HubAdvertisement, RegistryDirInput, SessionLineageRecord } from '../types/sessionRegistry.ts';

/** Overrides the runtime directory the hub and its session servers share. */
export const REGISTRY_DIR_ENV = 'DOOMPI_RUNTIME_DIR';

/** The version a lineage sidecar must carry to be read at all. */
export const SESSION_LINEAGE_RECORD_VERSION = 1;

/** The version a hub advertisement must carry to be read at all. */
export const HUB_ADVERTISEMENT_VERSION = 1;

const DEFAULT_RUN_DIR_SEGMENT = '.doompi/run';
const SESSIONS_SEGMENT = 'sessions';
const LINEAGE_EXTENSION = '.lineage.json';
const HUB_ADVERTISEMENT_FILE = 'hub.json';

/**
 * The single definition of where the session registry lives.
 *
 * The hub, the session server, and any package that spawns a session must land
 * on the same directory or a spawned session never appears in the rail. This
 * used to be copied into each of them; it lives here so there is one answer.
 */
export function resolveRegistryDir(input: RegistryDirInput): string {
  if (input.flagValue) return input.flagValue;
  if (input.envValue) return input.envValue;
  return `${input.homeDir}/${DEFAULT_RUN_DIR_SEGMENT}`;
}

/** The lineage sidecar's path, beside the session's own record file. */
export function sessionLineagePath(registryDir: string, sessionId: string): string {
  return `${registryDir}/${SESSIONS_SEGMENT}/${sessionId}${LINEAGE_EXTENSION}`;
}

/**
 * Reads a lineage sidecar's contents.
 *
 * Every failure means the same thing to a caller: this session has no known
 * parent. A torn write, a version this build predates, or a file that is not
 * JSON at all are all normal, because the sidecar is written by a separate
 * process that may be mid-write or newer than the reader.
 */
export function parseSessionLineage(raw: string): SessionLineageRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Partial<SessionLineageRecord>;
  if (record.version !== SESSION_LINEAGE_RECORD_VERSION) return undefined;
  if (typeof record.parentSessionId !== 'string' || record.parentSessionId === '') return undefined;
  const provenance = typeof record.provenance === 'string' ? record.provenance : '';
  return { version: SESSION_LINEAGE_RECORD_VERSION, parentSessionId: record.parentSessionId, provenance };
}

/** Where the hub publishes its local address, at the registry root. */
export function hubAdvertisementPath(registryDir: string): string {
  return `${registryDir}/${HUB_ADVERTISEMENT_FILE}`;
}

/**
 * Reads a hub advertisement's contents.
 *
 * Like the lineage sidecar, every failure collapses to "no hub advertised",
 * because a caller can do nothing different with a torn write than with a
 * missing file. The url is required to be a loopback http origin: this file is
 * a discovery hint for local processes, and honouring an arbitrary address out
 * of it would let anything that can write the registry directory redirect a
 * session-create call to a host of its choosing.
 */
export function parseHubAdvertisement(raw: string): HubAdvertisement | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Partial<HubAdvertisement>;
  if (record.version !== HUB_ADVERTISEMENT_VERSION) return undefined;
  if (typeof record.url !== 'string' || !isLoopbackHttpUrl(record.url)) return undefined;
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return undefined;
  return { version: HUB_ADVERTISEMENT_VERSION, url: record.url, pid: record.pid };
}

/** Whether a url is plain http to this machine, which is all this file may name. */
function isLoopbackHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  return (
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1'
  );
}
